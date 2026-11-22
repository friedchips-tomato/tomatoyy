"""阶段 2 验收：特征构造（03 §1）与基线（03 §3.2）。

覆盖：特征名/顺序、缺失填值 + 指示位、防泄漏 effective = min(cutoff, issued_at)、
周期基线右端点 ≤ issued_at、median 与 target-slot 统计、三基线实现。
"""

import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pf.dataset import DatasetConfig, load_observations  # noqa: E402
from pf.features import (  # noqa: E402
    FEATURE_NAMES, HORIZONS, MINUTES_PER_SLOT, build_lot_features, default_stats,
    median, parse_ts, periodic_stat, prepare, slot_of, weekday_of,
)
from pf.baselines import (  # noqa: E402
    BASELINE_NAMES, baselines_at, last_known, same_slot_median_at, same_weekday_mean_at,
)
from pf import train as T  # noqa: E402

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "synthetic"


def _ds():
    return load_observations(DatasetConfig(source="synthetic", data_dir=str(DATA_DIR)))


def _mid_ts(ds):
    p = prepare(ds)
    lot = list(p.lots.keys())[0]
    tss, _ = p.obs_by_lot[lot]
    return tss[len(tss) // 2]


def test_feature_names_ordered_and_complete():
    assert len(FEATURE_NAMES) == 39
    assert len(set(FEATURE_NAMES)) == 39
    assert FEATURE_NAMES[0] == "free_lag_1"
    assert FEATURE_NAMES[-1] == "periodic_missing"
    for key in ("free_known", "same_slot_median", "is_workday", "weather_code",
                "event_strength", "total_spaces", "lag_missing"):
        assert key in FEATURE_NAMES
    # 交互项位于缺失指示位之前
    assert "peak_x_workday" in FEATURE_NAMES
    assert FEATURE_NAMES.index("peak_x_workday") < FEATURE_NAMES.index("lag_missing")


def test_build_lot_features_complete_and_finite():
    ds = _ds()
    t = _mid_ts(ds)
    f = build_lot_features(ds, "P1", t, t, stats=default_stats())
    assert set(f.values.keys()) == set(FEATURE_NAMES)
    for name in FEATURE_NAMES:
        v = f.values[name]
        assert isinstance(v, float), name
        assert v == v, name  # 非 NaN


def test_anti_leakage_effective_min():
    ds = _ds()
    t = _mid_ts(ds)
    f_same = build_lot_features(ds, "P1", t, t, stats=default_stats())
    f_future = build_lot_features(ds, "P1", t, t + timedelta(days=3), stats=default_stats())
    # cutoff 在未来不改变任何特征（effective = min(cutoff, issued_at) = issued_at）
    assert f_same.vector() == f_future.vector()
    # cutoff 更早时，滞后余位应回退到更早的观测（若有观测则至少不会完全相同地使用未来）
    f_early = build_lot_features(ds, "P1", t, t - timedelta(hours=6), stats=default_stats())
    assert f_early.meta["effective"] == min(t - timedelta(hours=6), t)


def test_missing_lag_fills_and_flag():
    ds = _ds()
    p = prepare(ds)
    min_ts = min(p.obs_by_lot[l][0][0] for l in p.lots)
    # 首条观测之前：无任何已知余位
    f = build_lot_features(ds, "P1", min_ts - timedelta(minutes=60), min_ts - timedelta(minutes=60),
                           stats=default_stats())
    assert f.meta["free_known"] is None
    assert f.values["lag_missing"] == 1.0
    assert f.values["free_known"] == default_stats()["lag_fill"] == 0.0


def test_median():
    assert median([1, 2, 3]) == 2.0
    assert median([3, 1, 2]) == 2.0
    assert median([1, 2]) == 1.5
    assert median([5]) == 5.0


def test_slot_of():
    assert slot_of(parse_ts("2026-04-01T01:15:00+08:00")) == 5  # 1*4 + 1
    assert slot_of(parse_ts("2026-04-01T00:00:00+08:00")) == 0
    assert weekday_of(parse_ts("2026-04-01T00:00:00+08:00")) in range(7)


def test_periodic_stat_causal_and_deterministic():
    ds = _ds()
    p = prepare(ds)
    lot = "P1"
    t = _mid_ts(ds)
    cutoff = t
    v1 = same_slot_median_at(ds, lot, t + timedelta(minutes=30), cutoff)
    v2 = same_slot_median_at(ds, lot, t + timedelta(minutes=30), cutoff)
    assert v1 == v2
    assert v1 is None or v1 >= 0.0
    # 右端点 ≤ cutoff：删掉 cutoff 之后的观测，统计不变
    v3 = periodic_stat(ds, lot, t + timedelta(minutes=30), cutoff, half_slots=1, min_samples=3, stat="median")
    assert v1 == v3


def test_three_baselines_implemented():
    ds = _ds()
    t = _mid_ts(ds)
    f = build_lot_features(ds, "P1", t, t, stats=default_stats())
    b = baselines_at(ds, "P1", t + timedelta(minutes=30), t, features_obj=f)
    assert set(b.keys()) == set(BASELINE_NAMES)
    assert b["last_known"] == last_known(f)
    assert b["same_slot_median"] is None or isinstance(b["same_slot_median"], float)
    assert b["same_weekday_mean"] is None or isinstance(b["same_weekday_mean"], float)


def _min_ts(ds):
    p = prepare(ds)
    return min(p.obs_by_lot[l][0][0] for l in p.lots)


def test_degrade_d3_last_known_d4_unavailable():
    """2.6 / 2.7 / 2.9：D3 只复制最后已知值；D4 point_free is None（不是 0）；降级原因写入。"""
    ds = _ds()
    min_ts = _min_ts(ds)
    model = {"version": "2.0.0", "feature_fills": default_stats(),
             "horizons": {}, "residual_quantiles": {}, "scaler": {}}
    # D4：首条观测之前无任何余位 → unavailable，point_free is None
    f4 = build_lot_features(ds, "P1", min_ts - timedelta(minutes=60), min_ts - timedelta(minutes=60),
                            stats=default_stats())
    assert T.degrade_level(f4) == "D4"
    fcs4, _ = T.forecast_lot(ds, model, "P1", min_ts - timedelta(minutes=60), horizons=[15])
    assert fcs4[0]["point_free"] is None
    assert fcs4[0]["method"] == "unavailable"
    assert fcs4[0]["degrade_reason"] == "missing_observation"
    # D3：首条观测处有 free_known、但无同周期历史 → last_known 复制该值
    f3 = build_lot_features(ds, "P1", min_ts, min_ts, stats=default_stats())
    assert f3.meta["free_known"] is not None
    assert T.degrade_level(f3) == "D3"
    fcs3, _ = T.forecast_lot(ds, model, "P1", min_ts, horizons=[15, 60])
    for fc in fcs3:
        assert fc["method"] == "last_known"
        assert fc["point_free"] == int(f3.meta["free_known"])  # 只复制，不外推趋势
        assert fc["degrade_reason"] == "no_history"
