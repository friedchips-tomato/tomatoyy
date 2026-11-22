"""阶段 2 验收：无泄漏（03 §3.7）。

2.1 删除 issued_at 之后的所有观测，特征与预测逐位不变；
2.2 同周期基线统计窗口右端点 ≤ issued_at。
"""

import random
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pf.dataset import Dataset, DatasetConfig, load_observations  # noqa: E402
from pf.features import MINUTES_PER_SLOT, build_lot_features, compute_feature_stats, prepare, parse_ts  # noqa: E402
from pf.backtest import time_split, TrainRange  # noqa: E402
from pf import train as T  # noqa: E402
from pf.baselines import same_slot_median_at, same_weekday_mean_at  # noqa: E402

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "synthetic"


def _ds():
    return load_observations(DatasetConfig(source="synthetic", data_dir=str(DATA_DIR)))


def _bounds(ds):
    p = prepare(ds)
    lots = list(p.lots.keys())
    min_ts = min(p.obs_by_lot[l][0][0] for l in lots)
    max_ts = max(p.obs_by_lot[l][0][-1] for l in lots)
    return min_ts, max_ts


def test_delete_future_observations_identical():
    """2.1：随机 200 个 issued_at，删除其后观测，特征与预测逐位不变。"""
    ds = _ds()
    p = prepare(ds)
    lot_ids = list(p.lots.keys())
    min_ts, max_ts = _bounds(ds)
    split = time_split(min_ts, max_ts)
    stats = compute_feature_stats(ds, TrainRange(min_ts, split.test_start - timedelta(seconds=1)))
    model = T.train_linear_model(ds, TrainRange(min_ts, split.test_start - timedelta(seconds=1)), stats)

    rng = random.Random(0)
    step = timedelta(minutes=MINUTES_PER_SLOT)
    total = int((max_ts - min_ts).total_seconds() // (60 * MINUTES_PER_SLOT))
    checked = 0
    for _ in range(200):
        k = rng.randint(0, total)
        t = min_ts + step * k
        for lot_id in lot_ids:
            f_full = build_lot_features(ds, lot_id, t, t, stats=stats)
            fc_full, _ = T.forecast_lot(ds, model, lot_id, t, t, stats=stats)

            obs_trunc = [o for o in ds.observations if parse_ts(o["ts"]) <= t]
            ds_trunc = Dataset(lots=ds.lots, observations=obs_trunc, signals=ds.signals)
            f_trunc = build_lot_features(ds_trunc, lot_id, t, t, stats=stats)
            fc_trunc, _ = T.forecast_lot(ds_trunc, model, lot_id, t, t, stats=stats)

            assert f_full.vector() == f_trunc.vector(), (lot_id, t)
            assert [x["point_free"] for x in fc_full] == [x["point_free"] for x in fc_trunc], (lot_id, t)
            assert [x["method"] for x in fc_full] == [x["method"] for x in fc_trunc], (lot_id, t)
            checked += 1
    assert checked == 200 * len(lot_ids)


def test_baseline_window_right_endpoint():
    """2.2：同周期基线只用 ts ≤ cutoff 的观测（删除 cutoff 之后观测，统计不变）。"""
    ds = _ds()
    p = prepare(ds)
    lot_ids = list(p.lots.keys())
    min_ts, max_ts = _bounds(ds)
    rng = random.Random(1)
    step = timedelta(minutes=MINUTES_PER_SLOT)
    total = int((max_ts - min_ts).total_seconds() // (60 * MINUTES_PER_SLOT))
    for _ in range(20):
        k = rng.randint(0, total)
        t = min_ts + step * k
        target = t + timedelta(minutes=30)
        for lot_id in lot_ids:
            a = same_slot_median_at(ds, lot_id, target, t)
            b = same_weekday_mean_at(ds, lot_id, target, t)
            obs_trunc = [o for o in ds.observations if parse_ts(o["ts"]) <= t]
            ds_trunc = Dataset(lots=ds.lots, observations=obs_trunc, signals=ds.signals)
            a2 = same_slot_median_at(ds_trunc, lot_id, target, t)
            b2 = same_weekday_mean_at(ds_trunc, lot_id, target, t)
            assert a == a2
            assert b == b2
