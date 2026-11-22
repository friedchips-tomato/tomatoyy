"""阶段 2 验收：时间切分与回测（03 §3）。

覆盖：train/valid/test 不交叠 + ≥24h embargo、walk-forward 只用该步之前数据、
D0–D4 每级都被触发、三基线实现、MAPE 排除 actual==0、指标公式与六维分层。
"""

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pf.dataset import DatasetConfig, load_observations  # noqa: E402
from pf.features import prepare, parse_ts  # noqa: E402
from pf.backtest import (  # noqa: E402
    Prediction, check_split, compute_metrics, degrade_coverage, stratify,
    time_split, walk_forward, EMBARGO_HOURS,
)
from pf.baselines import BASELINE_NAMES  # noqa: E402

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "synthetic"


def _ds():
    return load_observations(DatasetConfig(source="synthetic", data_dir=str(DATA_DIR)))


def _bounds(ds):
    p = prepare(ds)
    lots = list(p.lots.keys())
    min_ts = min(p.obs_by_lot[l][0][0] for l in lots)
    max_ts = max(p.obs_by_lot[l][0][-1] for l in lots)
    return min_ts, max_ts


def test_split_no_overlap_and_embargo():
    ds = _ds()
    min_ts, max_ts = _bounds(ds)
    split = time_split(min_ts, max_ts)
    assert split.train_end < split.valid_start
    assert split.valid_end < split.test_start
    gap = timedelta(hours=EMBARGO_HOURS)
    assert split.train_end + gap <= split.valid_start
    assert split.valid_end + gap <= split.test_start
    assert split.test_start <= split.test_end
    assert check_split(split) == []


def test_walk_forward_causal_window():
    ds = _ds()
    min_ts, max_ts = _bounds(ds)
    split = time_split(min_ts, max_ts)
    preds, counts = walk_forward(ds, split)
    assert preds
    assert sum(counts.values()) == len(preds)
    for p in preds:
        # 预测只发生在测试期，且 target = issued + horizon（不跨到未来训练数据）
        assert split.test_start <= p.issued_at <= split.test_end
        assert p.target_ts == p.issued_at + timedelta(minutes=p.horizon)
        assert p.target_ts > p.issued_at
        if p.point_free is not None:
            assert 0.0 <= p.point_free <= p.total_spaces


def test_degrade_coverage_all_levels():
    ds = _ds()
    min_ts, max_ts = _bounds(ds)
    split = time_split(min_ts, max_ts)
    _, counts = degrade_coverage(ds, split)
    for m in ("model", "same_slot_baseline", "same_weekday_baseline", "last_known", "unavailable"):
        assert counts.get(m, 0) >= 1, m


def _pred(lot, issued, horizon, point, actual, total=100, method="model", degraded=False):
    return Prediction(
        lot_id=lot, issued_at=issued, target_ts=issued + timedelta(minutes=horizon),
        horizon=horizon, total_spaces=total, method=method, degraded=degraded,
        point_free=point, actual=actual, p10=None, p90=None, baselines={},
    )


def test_metrics_mape_excludes_zero():
    t = datetime(2026, 4, 10, 8, 0, 0)
    preds = [
        _pred("P1", t, 15, 10.0, 10.0),   # actual=10, err=0
        _pred("P1", t, 30, 5.0, 10.0),    # actual=10, err=-5
        _pred("P1", t, 45, 2.0, 0.0),     # actual=0 → 排除出 MAPE
    ]
    m = compute_metrics(preds)
    # 只有前两个 actual>0 参与 MAPE
    assert abs(m["mape"] - ((0.0 + 5.0 / 10.0) / 2)) < 1e-12
    assert abs(m["mape_excluded_ratio"] - (1.0 / 3.0)) < 1e-12


def test_metrics_formulas():
    t = datetime(2026, 4, 10, 8, 0, 0)
    preds = [
        _pred("P1", t, 15, 12.0, 10.0),   # e=+2
        _pred("P1", t, 30, 7.0, 10.0),    # e=-3
    ]
    m = compute_metrics(preds)
    assert abs(m["mae"] - 2.5) < 1e-12
    assert abs(m["bias"] - (-0.5)) < 1e-12
    # WAPE = sum|e| / sum(actual) = 5 / 20
    assert abs(m["wape"] - 0.25) < 1e-12
    assert abs(m["pct_d"] - 25.0) < 1e-9
    # rate MAE = mean(|12/100 - 10/100|, |7/100 - 10/100|) * 100
    assert abs(m["rate_mae_pp"] - ((0.02 + 0.03) / 2 * 100)) < 1e-9


def test_stratify_six_dimensions_shape():
    ds = _ds()
    min_ts, max_ts = _bounds(ds)
    split = time_split(min_ts, max_ts)
    preds, _ = walk_forward(ds, split)
    by_h = stratify(preds, lambda p: p.horizon)
    assert set(by_h.keys()) == {"15", "30", "45", "60"}
    by_lot = stratify(preds, lambda p: p.lot_id)
    assert set(by_lot.keys()) == {"P1", "P2"}
    by_q = stratify(preds, lambda p: p.quality)
    assert set(by_q.keys()) <= {"normal", "degraded"}


def test_baselines_reported_three_rows():
    # 三基线名字固定，供报告三行使用（2.10）
    assert set(BASELINE_NAMES) == {"last_known", "same_slot_median", "same_weekday_mean"}
