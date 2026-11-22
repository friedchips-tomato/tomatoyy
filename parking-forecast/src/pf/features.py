"""特征构造（03 §1）。防泄漏是硬红线。

约定：
- ``build_features(dataset, issued_at, cutoffs)`` 是唯一入口，返回 ``{lot_id: Features}``；
  ``cutoffs`` 是「允许看到的最晚观测时刻」，任何特征、任何基线统计量只使用
  ``ts <= min(cutoffs, issued_at)`` 的数据。
- 所有可能缺失的特征组都配一个 ``*_missing`` 布尔指示位；缺失时「填值 + 指示位」，
  不静默填 0（天气填训练集众数、事件填训练集中位数，见 03 §1）。
- 时区约定：合成数据一律 ``+08:00`` 墙钟时间。内部以 naive ``datetime`` 表示墙钟，
  时间戳字符串固定零填充 ISO 8601。

本模块被 Python 训练/回测与 ``runtime/features.mjs`` 各实现一份，二者必须逐位一致。
因此这里刻意只使用「双精度浮点 + 确定性的整数/字符串运算」，不引入会随平台浮动的
超越函数（sin/cos 用预计算的常量表，见 :data:`TIME_SIN` / :data:`TIME_COS` 等）。
"""

from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

__all__ = [
    "FEATURE_NAMES",
    "HORIZONS",
    "WEATHER_CODES",
    "PEAK_CODES",
    "TIME_SIN",
    "TIME_COS",
    "DOW_SIN",
    "DOW_COS",
    "Features",
    "build_features",
    "build_lot_features",
    "compute_feature_stats",
    "default_stats",
    "parse_ts",
    "fmt_ts",
    "slot_of",
    "weekday_of",
    "prepare",
    "median",
    "actual_free_at",
]

# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #
HORIZONS = (15, 30, 45, 60)
WEEK_DAYS = 7
SLOTS_PER_DAY = 96  # 15 分钟粒度
MINUTES_PER_SLOT = 15

WEATHER_CODES = {"sunny": 0, "cloudy": 1, "rain": 2, "heavy_rain": 3, "storm": 4}
RAIN_WEATHER = {"rain", "heavy_rain", "storm"}
PEAK_CODES = {"none": 0, "am_peak": 1, "pm_peak": 2, "evening": 3}

# 周期基线窗口（03 §1）
SAME_SLOT_WINDOW_DAYS = 28        # 过去 4 周
SAME_SLOT_HALF_SLOTS = 1          # ±15 分钟
SAME_WEEKDAY_HALF_SLOTS = 2       # ±30 分钟
SAME_SLOT_MIN_SAMPLES = 3
SAME_WEEKDAY_MIN_SAMPLES = 2

# 天气 / 事件的 lookback 窗口（用于「当前」天气与「活动/在 2 小时内」）
EVENT_LOOKBACK_MINUTES = 6 * 60
EVENT_HORIZON_MINUTES = 2 * 60

# 特征名（有序，模型与运行时共用；顺序决定点积顺序，切勿改动）
FEATURE_NAMES = [
    # 滞后余位
    "free_lag_1", "free_lag_2", "free_lag_4",
    "free_known", "known_age_min", "free_rate_known",
    "drain_15", "drain_60",
    # 周期基线
    "same_slot_mean", "same_slot_median", "same_weekday_mean", "same_day_hist",
    # 日历
    "is_workday", "is_holiday", "is_weekend", "is_peak", "peak_type",
    "days_since_holiday", "days_to_holiday",
    "time_of_day_sin", "time_of_day_cos", "dow_sin", "dow_cos",
    # 天气
    "weather_code", "is_rain", "temperature_c",
    # 事件
    "event_strength", "event_in_2h", "event_size",
    # 车场属性
    "total_spaces", "base_rate", "day_of_history",
    # 交互项
    "peak_x_workday", "rain_x_weekend",
    # 缺失指示位（直接参与训练）
    "lag_missing", "calendar_missing", "weather_missing", "event_missing", "periodic_missing",
]

# sin/cos 常量表（预计算，Python 与 JS 共用同一张表，避免平台超越函数差异导致逐位漂移）
TIME_SIN = [math.sin(2.0 * math.pi * i / SLOTS_PER_DAY) for i in range(SLOTS_PER_DAY)]
TIME_COS = [math.cos(2.0 * math.pi * i / SLOTS_PER_DAY) for i in range(SLOTS_PER_DAY)]
DOW_SIN = [math.sin(2.0 * math.pi * i / WEEK_DAYS) for i in range(WEEK_DAYS)]
DOW_COS = [math.cos(2.0 * math.pi * i / WEEK_DAYS) for i in range(WEEK_DAYS)]


# --------------------------------------------------------------------------- #
# 时间工具
# --------------------------------------------------------------------------- #
def parse_ts(s: str) -> datetime:
    """解析合成数据的 ISO 时间戳（截断时区偏移，按 +08:00 墙钟解释）。"""
    return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")


def fmt_ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + "+08:00"


def slot_of(dt: datetime) -> int:
    return dt.hour * 4 + dt.minute // MINUTES_PER_SLOT


def weekday_of(dt: datetime) -> int:
    """周一=0 .. 周日=6，与 JS 的 ``(getUTCDay()+6)%7`` 一致。"""
    return dt.weekday()


def _day_number(d: datetime) -> int:
    """自 1970-01-01 起的天数（与 JS ``Date.UTC/86400000`` 一致）。"""
    return (datetime(d.year, d.month, d.day) - datetime(1970, 1, 1)).days


def median(vals: Sequence[float]) -> float:
    """中位数。偶数长度取中间两数平均。实现与 JS 版逐位一致（值均为整数）。"""
    if not vals:
        raise ValueError("median of empty sequence")
    s = sorted(vals)
    n = len(s)
    if n % 2 == 1:
        return float(s[n // 2])
    return (s[n // 2 - 1] + s[n // 2]) / 2.0


# --------------------------------------------------------------------------- #
# 索引（惰性缓存到 dataset 对象上，避免每次 build_features 都重排）
# --------------------------------------------------------------------------- #
@dataclass
class _Prepared:
    lots: Dict[str, Dict[str, Any]]
    obs_by_lot: Dict[str, Tuple[List[datetime], List[Dict[str, Any]]]]
    calendar: Tuple[List[datetime], List[Dict[str, Any]]]
    weather: Tuple[List[datetime], List[Dict[str, Any]]]
    events: Tuple[List[datetime], List[Dict[str, Any]]]
    holidays: List[datetime]
    has_event_data: bool


def _sort_key(rec: Dict[str, Any]) -> datetime:
    return parse_ts(rec["ts"])


def prepare(dataset) -> _Prepared:
    """把 Dataset 预处理成可快速查询的结构，缓存到 ``dataset._pf_prepared``。"""
    cached = getattr(dataset, "_pf_prepared", None)
    if cached is not None:
        return cached

    lots = {l["lot_id"]: l for l in dataset.lots}
    obs_by_lot: Dict[str, Tuple[List[datetime], List[Dict[str, Any]]]] = {}
    for lot_id in lots:
        rows = sorted([o for o in dataset.observations if o["lot_id"] == lot_id], key=_sort_key)
        obs_by_lot[lot_id] = ([parse_ts(o["ts"]) for o in rows], rows)

    calendar_rows = sorted([s for s in dataset.signals if s["kind"] == "calendar"], key=_sort_key)
    weather_rows = sorted([s for s in dataset.signals if s["kind"] == "weather"], key=_sort_key)
    event_rows = sorted([s for s in dataset.signals if s["kind"] == "event"], key=_sort_key)

    holidays: List[datetime] = []
    seen = set()
    for s in calendar_rows:
        if s.get("is_holiday"):
            d = parse_ts(s["ts"]).date()
            if d not in seen:
                seen.add(d)
                holidays.append(datetime(d.year, d.month, d.day))
    holidays.sort()

    prepared = _Prepared(
        lots=lots,
        obs_by_lot=obs_by_lot,
        calendar=([parse_ts(s["ts"]) for s in calendar_rows], calendar_rows),
        weather=([parse_ts(s["ts"]) for s in weather_rows], weather_rows),
        events=([parse_ts(s["ts"]) for s in event_rows], event_rows),
        holidays=holidays,
        has_event_data=bool(event_rows),
    )
    dataset._pf_prepared = prepared
    return prepared


def _latest_at_or_before(tss: List[datetime], rows: List[Dict[str, Any]], cutoff: datetime):
    """返回 ts <= cutoff 的最后一条；无则 (None, None)。"""
    i = bisect_right(tss, cutoff) - 1
    if i < 0:
        return None, None
    return tss[i], rows[i]


# --------------------------------------------------------------------------- #
# 缺失填充统计（训练集口径）
# --------------------------------------------------------------------------- #
def default_stats() -> Dict[str, Any]:
    """无训练数据时的兜底填充统计（确定性常量，用于独立构造特征的场景）。"""
    return {
        "weather_code_mode": WEATHER_CODES["sunny"],
        "temperature_median": 25.0,
        "event_strength_median": 0.0,
        "base_rate": {},
        "lag_fill": 0.0,
        "periodic_fill": 0.0,
    }


def compute_feature_stats(dataset, split=None) -> Dict[str, Any]:
    """从训练区间计算缺失填充统计（03 §1「天气填众数 / 事件填中位数」）。

    ``split`` 为 ``backtest.Split``（含 ``train_end``）时只使用训练期信号，避免统计量泄漏；
    为 None 时（独立特征构造）退化为全量数据。
    """
    prepared = prepare(dataset)
    upper = split.train_end if split is not None else None

    weather_codes: List[int] = []
    temps: List[float] = []
    for i, ts in enumerate(prepared.weather[0]):
        if upper is not None and ts > upper:
            break
        s = prepared.weather[1][i]
        weather_codes.append(WEATHER_CODES.get(s.get("weather"), 0))
        if s.get("temperature_c") is not None:
            temps.append(float(s["temperature_c"]))

    event_strengths: List[float] = []
    for i, ts in enumerate(prepared.events[0]):
        if upper is not None and ts > upper:
            break
        v = prepared.events[1][i].get("event_strength")
        if v is not None:
            event_strengths.append(float(v))

    base_rate: Dict[str, float] = {}
    for lot_id, (tss, rows) in prepared.obs_by_lot.items():
        total = prepared.lots[lot_id]["total_spaces"]
        rates = []
        for i, ts in enumerate(tss):
            if upper is not None and ts > upper:
                break
            o = rows[i]
            if o["quality"] in ("ok", "stale") and o["free_spaces"] is not None:
                rates.append(o["free_spaces"] / float(total))
        base_rate[lot_id] = (sum(rates) / len(rates)) if rates else 0.0

    stats = default_stats()
    if weather_codes:
        stats["weather_code_mode"] = max(set(weather_codes), key=weather_codes.count)
    if temps:
        stats["temperature_median"] = median(temps)
    if event_strengths:
        stats["event_strength_median"] = median(event_strengths)
    stats["base_rate"] = base_rate
    return stats


# --------------------------------------------------------------------------- #
# 特征束
# --------------------------------------------------------------------------- #
@dataclass
class Features:
    values: Dict[str, float] = field(default_factory=dict)
    meta: Dict[str, Any] = field(default_factory=dict)

    def vector(self, names: Sequence[str] = FEATURE_NAMES) -> List[float]:
        return [self.values[n] for n in names]


# --------------------------------------------------------------------------- #
# 单特征组计算
# --------------------------------------------------------------------------- #
def _free_value_at_or_before(prepared: _Prepared, lot_id: str, cutoff: datetime,
                             qualities: Tuple[str, ...]) -> Optional[Tuple[datetime, int]]:
    """最近一条 ts <= cutoff 且 quality 命中、free_spaces 非空的观测，返回 (ts, free)。"""
    tss, rows = prepared.obs_by_lot[lot_id]
    i = bisect_right(tss, cutoff) - 1
    while i >= 0:
        o = rows[i]
        if o["quality"] in qualities and o["free_spaces"] is not None:
            return tss[i], int(o["free_spaces"])
        i -= 1
    return None


def _lag_features(prepared: _Prepared, lot_id: str, issued_at: datetime, effective: datetime,
                  stats: Dict[str, Any], values: Dict[str, float], meta: Dict[str, Any]):
    total = prepared.lots[lot_id]["total_spaces"]

    known = _free_value_at_or_before(prepared, lot_id, effective, ("ok", "stale"))
    if known is None:
        known_ts, free_known = None, None
    else:
        known_ts, free_known = known

    lags: Dict[str, Optional[int]] = {}
    for k in (1, 2, 4):
        cut = min(issued_at - timedelta(minutes=MINUTES_PER_SLOT * k), effective)
        hit = _free_value_at_or_before(prepared, lot_id, cut, ("ok", "stale"))
        lags["free_lag_%d" % k] = hit[1] if hit else None

    lag_missing = free_known is None
    if free_known is None:
        values["free_known"] = stats["lag_fill"]
        values["known_age_min"] = stats["lag_fill"]
        values["free_rate_known"] = stats["lag_fill"]
    else:
        values["free_known"] = float(free_known)
        values["known_age_min"] = (issued_at - known_ts).total_seconds() / 60.0
        values["free_rate_known"] = free_known / float(total)

    for k in (1, 2, 4):
        key = "free_lag_%d" % k
        values[key] = float(lags[key]) if lags[key] is not None else stats["lag_fill"]

    # drain（正 = 减少）：(滞后值 − 当前值) / 分钟
    if free_known is not None and lags["free_lag_1"] is not None:
        values["drain_15"] = (lags["free_lag_1"] - free_known) / float(MINUTES_PER_SLOT)
    else:
        values["drain_15"] = stats["lag_fill"]
    if free_known is not None and lags["free_lag_4"] is not None:
        values["drain_60"] = (lags["free_lag_4"] - free_known) / float(MINUTES_PER_SLOT * 4)
    else:
        values["drain_60"] = stats["lag_fill"]

    values["lag_missing"] = 1.0 if lag_missing else 0.0
    meta["free_known"] = free_known
    meta["free_known_ts"] = known_ts
    meta["age_seconds"] = int((issued_at - known_ts).total_seconds()) if known_ts is not None else None


def _periodic_features(prepared: _Prepared, lot_id: str, issued_at: datetime, effective: datetime,
                       stats: Dict[str, Any], values: Dict[str, float], meta: Dict[str, Any]):
    tss, rows = prepared.obs_by_lot[lot_id]
    issued_slot = slot_of(issued_at)
    issued_dow = weekday_of(issued_at)
    issued_date = issued_at.date()
    window_start = issued_at - timedelta(days=SAME_SLOT_WINDOW_DAYS)

    slot_vals: List[int] = []
    weekday_vals: List[int] = []
    today_vals: List[int] = []

    for i, ts in enumerate(tss):
        if ts > effective:
            break
        if ts < window_start:
            continue
        o = rows[i]
        if o["quality"] not in ("ok", "stale") or o["free_spaces"] is None:
            continue
        if ts.date() == issued_date:
            if ts < issued_at:
                today_vals.append(int(o["free_spaces"]))
            continue
        if weekday_of(ts) != issued_dow:
            continue
        dslot = slot_of(ts)
        if abs(dslot - issued_slot) <= SAME_SLOT_HALF_SLOTS:
            slot_vals.append(int(o["free_spaces"]))
        if abs(dslot - issued_slot) <= SAME_WEEKDAY_HALF_SLOTS:
            weekday_vals.append(int(o["free_spaces"]))

    periodic_missing = False

    slot_ok = len(slot_vals) >= SAME_SLOT_MIN_SAMPLES
    if slot_ok:
        values["same_slot_mean"] = sum(slot_vals) / float(len(slot_vals))
        values["same_slot_median"] = median(slot_vals)
    else:
        values["same_slot_mean"] = stats["periodic_fill"]
        values["same_slot_median"] = stats["periodic_fill"]
        periodic_missing = True

    weekday_ok = len(weekday_vals) >= SAME_WEEKDAY_MIN_SAMPLES
    if weekday_ok:
        values["same_weekday_mean"] = sum(weekday_vals) / float(len(weekday_vals))
    else:
        values["same_weekday_mean"] = stats["periodic_fill"]
        periodic_missing = True

    if today_vals:
        values["same_day_hist"] = median(today_vals)
    else:
        values["same_day_hist"] = stats["periodic_fill"]
        periodic_missing = True

    values["periodic_missing"] = 1.0 if periodic_missing else 0.0
    meta["same_slot_median"] = median(slot_vals) if slot_ok else None
    meta["same_weekday_mean"] = (sum(weekday_vals) / float(len(weekday_vals))) if weekday_ok else None


def _calendar_features(prepared: _Prepared, issued_at: datetime, effective: datetime,
                       values: Dict[str, float], meta: Dict[str, Any]):
    tss, rows = prepared.calendar
    _, sig = _latest_at_or_before(tss, rows, effective)
    issued_dow = weekday_of(issued_at)

    if sig is None:
        # 信号缺失：默认「工作日/周末」假设 + 显式标记（03 §1）
        is_weekend = issued_dow >= 5
        is_workday = not is_weekend
        is_holiday = False
        peak = "none"
        calendar_missing = True
        days_since = -7
        days_to = 7
    else:
        is_workday = bool(sig.get("is_workday", False))
        is_holiday = bool(sig.get("is_holiday", False))
        is_weekend = issued_dow >= 5
        peak = sig.get("peak") or "none"
        calendar_missing = False

        # days_since / days_to holiday（范围 −7..7，无则按边界截断）
        days_since = None
        days_to = None
        today_num = _day_number(issued_at)
        for h in prepared.holidays:
            hn = _day_number(h)
            if hn <= today_num:
                days_since = today_num - hn
            if hn >= today_num and days_to is None:
                days_to = hn - today_num
        days_since = -7 if days_since is None else max(-7, min(7, days_since))
        days_to = 7 if days_to is None else max(-7, min(7, days_to))

    is_peak = peak in ("am_peak", "pm_peak")
    slot = slot_of(issued_at)

    values["is_workday"] = 1.0 if is_workday else 0.0
    values["is_holiday"] = 1.0 if is_holiday else 0.0
    values["is_weekend"] = 1.0 if is_weekend else 0.0
    values["is_peak"] = 1.0 if is_peak else 0.0
    values["peak_type"] = float(PEAK_CODES.get(peak, 0))
    values["days_since_holiday"] = float(days_since)
    values["days_to_holiday"] = float(days_to)
    values["time_of_day_sin"] = TIME_SIN[slot]
    values["time_of_day_cos"] = TIME_COS[slot]
    values["dow_sin"] = DOW_SIN[issued_dow]
    values["dow_cos"] = DOW_COS[issued_dow]
    values["calendar_missing"] = 1.0 if calendar_missing else 0.0
    meta["calendar_missing"] = calendar_missing
    meta["is_workday"] = is_workday
    meta["is_weekend"] = is_weekend
    meta["peak"] = peak


def _weather_features(prepared: _Prepared, issued_at: datetime, effective: datetime,
                      stats: Dict[str, Any], values: Dict[str, float], meta: Dict[str, Any]):
    tss, rows = prepared.weather
    _, sig = _latest_at_or_before(tss, rows, effective)

    if sig is None:
        values["weather_code"] = float(stats["weather_code_mode"])
        values["is_rain"] = 0.0
        values["temperature_c"] = float(stats["temperature_median"])
        values["weather_missing"] = 1.0
        meta["weather"] = None
    else:
        wname = sig.get("weather")
        code = WEATHER_CODES.get(wname, 0)
        values["weather_code"] = float(code)
        values["is_rain"] = 1.0 if wname in RAIN_WEATHER else 0.0
        temp = sig.get("temperature_c")
        values["temperature_c"] = float(temp) if temp is not None else float(stats["temperature_median"])
        values["weather_missing"] = 0.0
        meta["weather"] = wname


def _event_features(prepared: _Prepared, issued_at: datetime, effective: datetime,
                    stats: Dict[str, Any], values: Dict[str, float], meta: Dict[str, Any]):
    tss, rows = prepared.events

    if not prepared.has_event_data:
        # 完全无事件数据：不等于强度 0（03 §1）
        values["event_strength"] = float(stats["event_strength_median"])
        values["event_in_2h"] = 0.0
        values["event_size"] = 0.0
        values["event_missing"] = 1.0
        meta["has_event"] = False
        return

    lo = issued_at - timedelta(minutes=EVENT_LOOKBACK_MINUTES)
    in2h_lo = issued_at - timedelta(minutes=EVENT_HORIZON_MINUTES)
    strengths: List[float] = []
    event_ids = set()
    in_2h = False
    for i, ts in enumerate(tss):
        if ts > effective:
            break
        if ts < lo:
            continue
        strengths.append(float(rows[i].get("event_strength") or 0.0))
        if ts >= in2h_lo:
            in_2h = True
        eid = rows[i].get("event_id")
        if eid:
            event_ids.add(eid)

    values["event_strength"] = max(strengths) if strengths else 0.0
    values["event_in_2h"] = 1.0 if in_2h else 0.0
    values["event_size"] = float(len(event_ids))
    values["event_missing"] = 0.0
    meta["has_event"] = bool(strengths)


def _lot_features(prepared: _Prepared, lot_id: str, issued_at: datetime, effective: datetime,
                  stats: Dict[str, Any], values: Dict[str, float]):
    lot = prepared.lots[lot_id]
    total = lot["total_spaces"]
    values["total_spaces"] = float(total)
    values["base_rate"] = float(stats["base_rate"].get(lot_id, 0.0))

    tss, rows = prepared.obs_by_lot[lot_id]
    days = set()
    for i, ts in enumerate(tss):
        if ts > effective:
            break
        if rows[i]["quality"] in ("ok", "stale") and rows[i]["free_spaces"] is not None:
            days.add(ts.date())
    values["day_of_history"] = float(len(days))


def actual_free_at(dataset, lot_id: str, ts: datetime) -> Optional[int]:
    """精确命中 ``ts`` 的观测余位（非空即视为真值）；无则 None。"""
    prepared = prepare(dataset)
    tss, rows = prepared.obs_by_lot[lot_id]
    i = bisect_left(tss, ts)
    if i < len(tss) and tss[i] == ts:
        o = rows[i]
        if o["free_spaces"] is not None:
            return int(o["free_spaces"])
    return None


def periodic_stat(dataset, lot_id: str, target_ts: datetime, cutoff: datetime,
                  half_slots: int, min_samples: int, stat: str = "median") -> Optional[float]:
    """目标时刻（target_ts）同星期几 + 同时刻（±half_slots 个 15 分钟槽）的历史统计量。

    用于基线 B2/B3 与降级链 D1/D2 的**目标槽**预测：只使用 ``ts <= cutoff``（回看 4 周，
    排除 cutoff 当天）的观测。``stat`` ∈ ``median`` / ``mean``。样本 < ``min_samples`` 返回 None。
    """
    prepared = prepare(dataset)
    tss, rows = prepared.obs_by_lot[lot_id]
    target_slot = slot_of(target_ts)
    target_dow = weekday_of(target_ts)
    cutoff_date = cutoff.date()
    window_start = target_ts - timedelta(days=SAME_SLOT_WINDOW_DAYS)

    vals: List[int] = []
    for i, ts in enumerate(tss):
        if ts > cutoff:
            break
        if ts < window_start:
            continue
        o = rows[i]
        if o["quality"] not in ("ok", "stale") or o["free_spaces"] is None:
            continue
        if ts.date() >= cutoff_date:
            continue
        if weekday_of(ts) != target_dow:
            continue
        if abs(slot_of(ts) - target_slot) <= half_slots:
            vals.append(int(o["free_spaces"]))

    if len(vals) < min_samples:
        return None
    if stat == "median":
        return median(vals)
    return sum(vals) / float(len(vals))


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
def build_lot_features(dataset, lot_id: str, issued_at: datetime, cutoffs: datetime,
                       stats: Optional[Dict[str, Any]] = None) -> Features:
    """构造单个车场在 ``issued_at`` 时刻的完整特征向量。

    ``cutoffs`` 是「允许看到的最晚观测时刻」；内部取 ``effective = min(cutoffs, issued_at)``。
    """
    effective = min(cutoffs, issued_at) if cutoffs is not None else issued_at
    prepared = prepare(dataset)
    if stats is None:
        stats = default_stats()

    values: Dict[str, float] = {}
    meta: Dict[str, Any] = {"lot_id": lot_id, "issued_at": issued_at, "effective": effective}

    _lag_features(prepared, lot_id, issued_at, effective, stats, values, meta)
    _periodic_features(prepared, lot_id, issued_at, effective, stats, values, meta)
    _calendar_features(prepared, issued_at, effective, values, meta)
    _weather_features(prepared, issued_at, effective, stats, values, meta)
    _event_features(prepared, issued_at, effective, stats, values, meta)
    _lot_features(prepared, lot_id, issued_at, effective, stats, values)

    # 交互项
    values["peak_x_workday"] = values["is_peak"] * values["is_workday"]
    values["rain_x_weekend"] = values["is_rain"] * values["is_weekend"]

    # 保证所有特征名都有值
    for name in FEATURE_NAMES:
        if name not in values:
            values[name] = 0.0

    return Features(values=values, meta=meta)


def build_features(dataset, issued_at: datetime, cutoffs: datetime,
                   stats: Optional[Dict[str, Any]] = None) -> Dict[str, Features]:
    """构造 ``issued_at`` 时刻所有车场的特征向量，返回 ``{lot_id: Features}``。

    满足 03 §3.1 的固定签名：``cutoffs`` 是「允许看到的最晚观测时刻」。
    """
    prepared = prepare(dataset)
    if stats is None:
        stats = default_stats()
    return {lot_id: build_lot_features(dataset, lot_id, issued_at, cutoffs, stats) for lot_id in prepared.lots}
