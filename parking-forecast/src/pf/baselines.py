"""基线（03 §3.2）。三个正式基线 + 「前一日同时段」诊断行。

- B1 ``last_known``：预测 = 最后已知余位（当前值持平假设）。
- B2 ``same_slot_median``：过去 4 周同星期几 + **目标时刻**（±15 分钟）的中位数。
- B3 ``same_weekday_mean``：过去 4 周同星期几 + **目标时刻**（±30 分钟）的均值。
- 诊断：``previous_day_same_time``：前一日同一时段（不进正式基线表）。

注意：B2/B3 是对**目标时刻（target_ts）**的同星期同时段统计（不是 issued_at 槽），
右端点 ≤ issued_at；B1 与 horizon 无关。实现复用 :mod:`pf.features` 的同一套窗口计算。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from . import features
from .features import Features, prepare, periodic_stat, default_stats, build_lot_features

__all__ = [
    "B1_LAST_KNOWN",
    "B2_SAME_SLOT_MEDIAN",
    "B3_SAME_WEEKDAY_MEAN",
    "BASELINE_NAMES",
    "last_known",
    "same_slot_median_at",
    "same_weekday_mean_at",
    "previous_day_same_time",
    "baselines_at",
]

B1_LAST_KNOWN = "last_known"
B2_SAME_SLOT_MEDIAN = "same_slot_median"
B3_SAME_WEEKDAY_MEAN = "same_weekday_mean"
BASELINE_NAMES = (B1_LAST_KNOWN, B2_SAME_SLOT_MEDIAN, B3_SAME_WEEKDAY_MEAN)


def last_known(f: Features) -> Optional[float]:
    """B1：最后已知余位（当前值持平假设）。无则为 None。"""
    v = f.meta.get("free_known")
    return float(v) if v is not None else None


def same_slot_median_at(dataset, lot_id: str, target_ts: datetime, cutoff: datetime) -> Optional[float]:
    """B2：过去 4 周同星期几 + 目标时刻（±15 分钟）中位数。"""
    return periodic_stat(dataset, lot_id, target_ts, cutoff,
                         half_slots=features.SAME_SLOT_HALF_SLOTS,
                         min_samples=features.SAME_SLOT_MIN_SAMPLES,
                         stat="median")


def same_weekday_mean_at(dataset, lot_id: str, target_ts: datetime, cutoff: datetime) -> Optional[float]:
    """B3：过去 4 周同星期几 + 目标时刻（±30 分钟）均值。"""
    return periodic_stat(dataset, lot_id, target_ts, cutoff,
                         half_slots=features.SAME_WEEKDAY_HALF_SLOTS,
                         min_samples=features.SAME_WEEKDAY_MIN_SAMPLES,
                         stat="mean")


def previous_day_same_time(dataset, lot_id: str, target_ts: datetime, cutoff: datetime) -> Optional[float]:
    """前一日同一时段（±15 分钟窗口）的余位。诊断用，不进正式基线表。"""
    effective = min(cutoff, target_ts)
    prepared = prepare(dataset)
    anchor = target_ts - timedelta(hours=24)
    lo = anchor - timedelta(minutes=15)
    hi = anchor + timedelta(minutes=15)
    if hi > effective:
        hi = effective

    tss, rows = prepared.obs_by_lot[lot_id]
    best = None
    best_dist = None
    for i, ts in enumerate(tss):
        if ts > hi:
            break
        if ts < lo:
            continue
        o = rows[i]
        if o["quality"] not in ("ok", "stale") or o["free_spaces"] is None:
            continue
        dist = abs((ts - anchor).total_seconds())
        if best_dist is None or dist < best_dist:
            best_dist = dist
            best = int(o["free_spaces"])
    return float(best) if best is not None else None


def baselines_at(dataset, lot_id: str, target_ts: datetime, cutoff: datetime,
                 features_obj: Optional[Features] = None) -> dict:
    """返回三基线对 ``target_ts`` 的预测。

    ``features_obj`` 为 issued_at 的特征束（B1 从里面取 free_known），
    不传则单独构造（会额外算一次 issued 特征）。
    """
    if features_obj is None:
        features_obj = build_lot_features(dataset, lot_id, cutoff, cutoff, stats=default_stats())
    return {
        B1_LAST_KNOWN: last_known(features_obj),
        B2_SAME_SLOT_MEDIAN: same_slot_median_at(dataset, lot_id, target_ts, cutoff),
        B3_SAME_WEEKDAY_MEAN: same_weekday_mean_at(dataset, lot_id, target_ts, cutoff),
    }
