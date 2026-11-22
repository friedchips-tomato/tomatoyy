"""时间切分与回测（03 §3）。

- ``time_split``：时间有序切分（train/valid/test 不交叠 + ≥24h embargo）。
- ``walk_forward``：测试期每日重训、逐 15 分钟步进、只用该步之前数据（主报告口径）。
- ``degrade_coverage``：全时间轴降级路径覆盖扫描（D0–D4 每级都被触发）。
- ``compute_metrics`` / ``stratify``：绝对车位 MAE/RMSE/MAPE/WAPE/空置率 MAE/Bias/命中率，
  以及 ≤20% 四口径 A/B/C/D 与六维分层。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from . import features as F
from . import baselines as B
from . import train as T
from .features import FEATURE_NAMES, HORIZONS, prepare, default_stats, compute_feature_stats, fmt_ts, parse_ts

__all__ = [
    "Split",
    "TrainRange",
    "Prediction",
    "time_split",
    "check_split",
    "walk_forward",
    "degrade_coverage",
    "compute_metrics",
    "stratify",
    "overall_metrics",
    "EMBARGO_HOURS",
]

EMBARGO_HOURS = 24.0


@dataclass
class TrainRange:
    train_start: datetime
    train_end: datetime


@dataclass
class Split:
    train_start: datetime
    train_end: datetime
    valid_start: datetime
    valid_end: datetime
    test_start: datetime
    test_end: datetime
    embargo_hours: float = EMBARGO_HOURS

    def train_range(self) -> TrainRange:
        return TrainRange(self.train_start, self.train_end)


@dataclass
class Prediction:
    lot_id: str
    issued_at: datetime
    target_ts: datetime
    horizon: int
    total_spaces: int
    method: str
    degraded: bool
    point_free: Optional[float]
    actual: Optional[float]
    p10: Optional[float]
    p90: Optional[float]
    baselines: Dict[str, Optional[float]] = field(default_factory=dict)
    is_workday: bool = True
    is_weekend: bool = False
    weather: Optional[str] = None
    has_event: bool = False
    quality: str = "normal"  # normal | degraded


# --------------------------------------------------------------------------- #
# 时间切分
# --------------------------------------------------------------------------- #
def time_split(min_ts: datetime, max_ts: datetime, embargo_hours: float = EMBARGO_HOURS,
               train_days: Optional[int] = None, valid_days: Optional[int] = None,
               test_days: Optional[int] = None) -> Split:
    """时间有序切分。默认：≥90 天用 60/15/15；短数据（合成）按 60%/20%/20% 缩放。

    切分点后各留 ``embargo_hours``（默认 24h）作为隔离带（03 §3.1）。
    """
    total_days = (max_ts.date() - min_ts.date()).days + 1
    embargo_days = int(math.ceil(embargo_hours / 24.0))

    if train_days is None:
        if total_days >= 90:
            train_days, valid_days, test_days = 60, 15, 15
        else:
            avail = max(3, total_days - 2 * embargo_days)
            train_days = max(2, round(avail * 0.60))
            valid_days = max(1, round(avail * 0.20))
            test_days = max(1, avail - train_days - valid_days)

    day0 = datetime(min_ts.year, min_ts.month, min_ts.day)
    train_start = min_ts
    train_end = day0 + timedelta(days=train_days) - timedelta(seconds=1)
    valid_start = train_end + timedelta(seconds=1) + timedelta(hours=embargo_hours)
    valid_end = valid_start + timedelta(days=valid_days) - timedelta(seconds=1)
    test_start = valid_end + timedelta(seconds=1) + timedelta(hours=embargo_hours)
    test_end = max_ts

    return Split(
        train_start=train_start, train_end=train_end,
        valid_start=valid_start, valid_end=valid_end,
        test_start=test_start, test_end=test_end,
        embargo_hours=embargo_hours,
    )


def check_split(split: Split) -> List[str]:
    """返回切分违规描述列表（空 = 通过）。"""
    problems = []
    gap = timedelta(hours=split.embargo_hours)
    if split.train_end >= split.valid_start:
        problems.append("train/valid 交叠")
    if split.train_end + gap > split.valid_start:
        problems.append("train/valid embargo < %sh" % split.embargo_hours)
    if split.valid_end >= split.test_start:
        problems.append("valid/test 交叠")
    if split.valid_end + gap > split.test_start:
        problems.append("valid/test embargo < %sh" % split.embargo_hours)
    if split.test_start > split.test_end:
        problems.append("test 区间为空")
    return problems


# --------------------------------------------------------------------------- #
# 回测：walk-forward（主报告口径）
# --------------------------------------------------------------------------- #
def _iter_test_days(split: Split):
    d = split.test_start.date()
    end = split.test_end.date()
    cur = datetime(d.year, d.month, d.day)
    while cur <= split.test_end:
        yield cur
        nxt = cur + timedelta(days=1)
        if nxt.date() > end and cur.date() < end:
            break
        cur = nxt


def walk_forward(dataset, split: Split, stats: Optional[Dict[str, Any]] = None):
    """测试期每日重训 + 逐 15 分钟步进。返回 ``(predictions, method_counts)``。

    模型每日在「该日 00:00 之前的所有数据」上重训（含基线统计量），
    每步特征只用到 ``ts <= issued_at``（cutoffs=issued_at）。
    """
    prepared = prepare(dataset)
    lot_ids = list(prepared.lots.keys())
    total_by_lot = {l: int(prepared.lots[l]["total_spaces"]) for l in lot_ids}
    min_ts = split.train_start

    predictions: List[Prediction] = []
    method_counts: Dict[str, int] = {}

    step = timedelta(minutes=F.MINUTES_PER_SLOT)
    for day in _iter_test_days(split):
        day_end_train = day - timedelta(seconds=1)
        tr = TrainRange(min_ts, day_end_train)
        day_stats = stats if stats is not None else compute_feature_stats(dataset, tr)
        model = T.train_linear_model(dataset, tr, day_stats)

        t = day
        while t <= split.test_end and t.date() == day.date():
            for lot_id in lot_ids:
                forecasts, f = T.forecast_lot(dataset, model, lot_id, t, t,
                                              horizons=HORIZONS, stats=day_stats)
                baselines = {}
                for h in HORIZONS:
                    target = t + timedelta(minutes=h)
                    baselines[str(h)] = B.baselines_at(dataset, lot_id, target, t, features_obj=f)
                for fc in forecasts:
                    h = fc["horizon_minutes"]
                    actual = F.actual_free_at(dataset, lot_id, parse_ts(fc["target_ts"]))
                    method = fc["method"]
                    method_counts[method] = method_counts.get(method, 0) + 1
                    predictions.append(Prediction(
                        lot_id=lot_id,
                        issued_at=t,
                        target_ts=parse_ts(fc["target_ts"]),
                        horizon=h,
                        total_spaces=total_by_lot[lot_id],
                        method=method,
                        degraded=fc["degraded"],
                        point_free=float(fc["point_free"]) if fc["point_free"] is not None else None,
                        actual=float(actual) if actual is not None else None,
                        p10=float(fc["p10"]) if fc["p10"] is not None else None,
                        p90=float(fc["p90"]) if fc["p90"] is not None else None,
                        baselines=baselines[str(h)],
                        is_workday=bool(f.meta.get("is_workday")),
                        is_weekend=bool(f.meta.get("is_weekend")),
                        weather=f.meta.get("weather"),
                        has_event=bool(f.meta.get("has_event")),
                        quality="degraded" if fc["degraded"] else "normal",
                    ))
            t += step

    return predictions, method_counts


def degrade_coverage(dataset, split: Split, stats: Optional[Dict[str, Any]] = None):
    """全时间轴降级覆盖扫描（03 §3.7#5）：返回 ``(predictions, method_counts)``。

    用 train 区间训练好的固定模型，按 15 分钟步进对每个 issued_at 做因果预测，
    统计 D0–D4 每级的触发次数与每级指标。

    - 自然扫描从 ``min_obs − 60min`` 开始，覆盖 D0 / D2 / D3 / D4
      （D4 = 首条观测之前无任何余位 → ``unavailable``）。
    - D1（``same_slot_baseline`` = 历史充足但特征缺失）在合成数据里不会自然出现，
      这里用「移除天气信号」的构造场景补上，保证 D0–D4 每一级都被触发过。
    """
    from .dataset import Dataset

    prepared = prepare(dataset)
    lot_ids = list(prepared.lots.keys())
    total_by_lot = {l: int(prepared.lots[l]["total_spaces"]) for l in lot_ids}
    if stats is None:
        stats = compute_feature_stats(dataset, split.train_range())
    model = T.train_linear_model(dataset, split.train_range(), stats)

    min_obs = min(prepared.obs_by_lot[l][0][0] for l in lot_ids)
    max_obs = max(prepared.obs_by_lot[l][0][-1] for l in lot_ids)

    predictions: List[Prediction] = []
    method_counts: Dict[str, int] = {}

    def _scan(ds, lots, start, end, meta_tag=""):
        for t in _timesteps(start, end):
            for lot_id in lots:
                forecasts, f = T.forecast_lot(ds, model, lot_id, t, t, horizons=HORIZONS, stats=stats)
                for fc in forecasts:
                    h = fc["horizon_minutes"]
                    actual = F.actual_free_at(ds, lot_id, parse_ts(fc["target_ts"]))
                    method = fc["method"]
                    method_counts[method] = method_counts.get(method, 0) + 1
                    predictions.append(Prediction(
                        lot_id=lot_id, issued_at=t, target_ts=parse_ts(fc["target_ts"]),
                        horizon=h, total_spaces=total_by_lot.get(lot_id, 0), method=method,
                        degraded=fc["degraded"],
                        point_free=float(fc["point_free"]) if fc["point_free"] is not None else None,
                        actual=float(actual) if actual is not None else None,
                        p10=float(fc["p10"]) if fc["p10"] is not None else None,
                        p90=float(fc["p90"]) if fc["p90"] is not None else None,
                        is_workday=bool(f.meta.get("is_workday")),
                        is_weekend=bool(f.meta.get("is_weekend")),
                        weather=f.meta.get("weather"),
                        has_event=bool(f.meta.get("has_event")),
                        quality="degraded" if fc["degraded"] else "normal",
                    ))

    _scan(dataset, lot_ids, min_obs - timedelta(minutes=60), max_obs)

    # D1 构造场景：历史充足但天气信号缺失 → same_slot_baseline
    ds_nowx = Dataset(lots=dataset.lots, observations=dataset.observations,
                      signals=[s for s in dataset.signals if s["kind"] != "weather"])
    mid = min_obs + timedelta(days=11)
    _scan(ds_nowx, lot_ids, mid, mid + timedelta(hours=3))

    return predictions, method_counts


def _timesteps(start: datetime, end: datetime):
    step = timedelta(minutes=F.MINUTES_PER_SLOT)
    t = start
    while t <= end:
        yield t
        t += step


# --------------------------------------------------------------------------- #
# 指标
# --------------------------------------------------------------------------- #
def _scored(preds: Iterable[Prediction]) -> List[Prediction]:
    return [p for p in preds if p.point_free is not None and p.actual is not None]


def compute_metrics(preds: Sequence[Prediction]) -> Dict[str, Any]:
    """对一组 Prediction 计算 03 §3.4 全部指标 + ≤20% 四口径。"""
    ps = _scored(preds)
    n = len(ps)
    empty = {
        "n": 0, "mae": None, "rmse": None, "mape": None, "mape_excluded_ratio": None,
        "wape": None, "rate_mae_pp": None, "bias": None, "hit_rate": None,
        "pct_a": None, "pct_b": None, "pct_c": None, "pct_d": None,
        "mean_actual": None, "mean_total": None,
    }
    if n == 0:
        return empty

    errs = [p.point_free - p.actual for p in ps]
    abs_errs = [abs(e) for e in errs]
    mae = sum(abs_errs) / n
    rmse = math.sqrt(sum(e * e for e in errs) / n)
    bias = sum(errs) / n
    hit = sum(1 for e in errs if abs(e) <= 1.0) / n

    pos = [p for p in ps if p.actual > 0]
    mape = (sum(abs(p.point_free - p.actual) / p.actual for p in pos) / len(pos)) if pos else None
    mape_excluded_ratio = 1.0 - (len(pos) / n)

    sum_actual = sum(p.actual for p in ps)
    wape = (sum(abs_errs) / sum_actual) if sum_actual > 0 else None

    rate_mae_pp = sum(abs(p.point_free / p.total_spaces - p.actual / p.total_spaces) for p in ps) / n * 100.0

    mean_actual = sum(p.actual for p in ps) / n
    mean_total = sum(p.total_spaces for p in ps) / n
    pct_a = (mae / mean_actual * 100.0) if mean_actual > 0 else None
    pct_b = (mae / mean_total * 100.0) if mean_total > 0 else None
    pct_c = rate_mae_pp
    pct_d = (wape * 100.0) if wape is not None else None

    return {
        "n": n, "mae": mae, "rmse": rmse, "mape": mape,
        "mape_excluded_ratio": mape_excluded_ratio, "wape": wape,
        "rate_mae_pp": rate_mae_pp, "bias": bias, "hit_rate": hit,
        "pct_a": pct_a, "pct_b": pct_b, "pct_c": pct_c, "pct_d": pct_d,
        "mean_actual": mean_actual, "mean_total": mean_total,
    }


def overall_metrics(preds: Sequence[Prediction]) -> Dict[str, Any]:
    return compute_metrics(preds)


def stratify(preds: Sequence[Prediction], key_fn: Callable[[Prediction], Any]) -> Dict[str, Dict[str, Any]]:
    """按 ``key_fn`` 分层计算指标，返回 ``{stratum: metrics}``。"""
    groups: Dict[str, List[Prediction]] = {}
    for p in preds:
        k = str(key_fn(p))
        groups.setdefault(k, []).append(p)
    return {k: compute_metrics(v) for k, v in sorted(groups.items())}
