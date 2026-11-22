"""停车推荐、排序与打分（04 §3）。

- 打分方向**分高靠前**：``score = Σ weight_k(preference) × normalized_k × 100``。
- 权重按 04 §3.2（positive 权重归一化到 1.0；``restriction_penalty`` 为独立负项）。
- 归一化上限（cap）为显式常量（写进 ``model.json`` 的 ``ranking_caps``，2.25）。
- 硬过滤在打分前（04 §3.3）：access 不满足 / 预计余位 0 且无错峰 / 限高不匹配 → 排除并给理由；
  D4 不排除但 ``confidence=0``。
- 错峰方案（04 §3.4）：+30/+60 分钟到达预测。
- 人话理由：确定性字符串模板，逐条回溯到 ``score_breakdown``（04 §4）。
- ``transfer`` 字段保留但 ``feasible`` 一律 false、``note="暂无可用接驳点数据"``（04 §5）。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from . import features as F
from . import train as T
from .features import parse_ts, fmt_ts, default_stats

__all__ = [
    "RANKING_CAPS",
    "RANKING_WEIGHTS",
    "FACTOR_ORDER",
    "confidence_from_forecast",
    "compute_fee",
    "score_lot",
    "make_reasons",
    "recommend",
    "access_check",
    "height_check",
    "round_half_up",
]

# 归一化上限（04 §3.1）——显式常量，写进 model.json，保证可复算
RANKING_CAPS = {
    "need": 1.0,                 # 有位即可（单车）
    "walk_cap_min": 15.0,        # 步行时间上限
    "total_cap_min": 30.0,       # 总时间上限
    "fee_cap_cny": 30.0,         # 费用上限（示范值）
    "drive_minutes_estimate": 5.0,  # 无路网数据时的驾车常数估计（04 §3.2）
    "park_minutes": 2.0,            # 停车耗时估计
    "stay_hours": 2.0,              # 默认停留时长（04 §4 示例）
    "restriction_one_way_penalty": 0.2,  # 单行（只展示不判断）的轻微惩罚
}

# 偏好权重（04 §3.2）；positive 权重和 = 1.0，restriction_penalty 为独立负项
RANKING_WEIGHTS = {
    "default": {
        "arrive_free": 0.30, "arrive_free_rate": 0.15, "walk_cost": 0.20,
        "total_time": 0.20, "fee_cost": 0.05, "confidence": 0.10,
        "restriction_penalty": -0.10,
    },
    "save_time": {
        "arrive_free": 0.25, "arrive_free_rate": 0.10, "walk_cost": 0.10,
        "total_time": 0.35, "fee_cost": 0.05, "confidence": 0.15,
        "restriction_penalty": -0.10,
    },
    "less_walking": {
        "arrive_free": 0.25, "arrive_free_rate": 0.10, "walk_cost": 0.40,
        "total_time": 0.10, "fee_cost": 0.05, "confidence": 0.10,
        "restriction_penalty": -0.10,
    },
}

FACTOR_ORDER = ["arrive_free", "arrive_free_rate", "walk_cost", "total_time",
                "fee_cost", "confidence", "restriction_penalty"]


def round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _age_seconds(forecast: Dict[str, Any]) -> Optional[float]:
    if not forecast.get("data_asof"):
        return None
    issued = parse_ts(forecast["issued_at"])
    asof = parse_ts(forecast["data_asof"])
    return (issued - asof).total_seconds()


def confidence_from_forecast(forecast: Dict[str, Any]) -> float:
    """预测可信度 ∈ [0,1]：来自预测方法与数据新鲜度（04 §3.1）。确定性。"""
    method = forecast.get("method")
    if method == "unavailable":
        return 0.0
    base = {
        "model": 0.9,
        "same_slot_baseline": 0.6,
        "same_weekday_baseline": 0.5,
        "last_known": 0.3,
    }.get(method, 0.5)
    age = _age_seconds(forecast)
    if age is None:
        mult = 0.5
    elif age <= 180:
        mult = 1.0
    elif age <= 900:
        mult = 0.8
    else:
        mult = 0.5
    return base * mult


def compute_fee(fee: Dict[str, Any], stay_hours: float) -> Optional[float]:
    """按 fee 结构 + 停留时长估算费用；``unknown`` 时为 None。"""
    mode = fee.get("mode")
    amount = fee.get("amount")
    if mode == "unknown" or amount is None:
        return None
    if mode == "flat":
        return float(amount)
    # hourly
    return float(amount) * stay_hours


def access_check(lot: Dict[str, Any], arrive_at: datetime) -> tuple:
    """返回 ``(ok, reasons)``。不满足开放/限行时段则排除（04 §6）。"""
    reasons: List[str] = []
    access = lot.get("access") or {}
    oh = access.get("open_hours")
    if oh:
        lo, hi = oh.split("-")
        if not _in_hours(arrive_at, lo, hi):
            reasons.append("不在开放时间（%s）" % oh)
    for r in access.get("restricted_hours") or []:
        if _in_hours(arrive_at, r["from"], r["to"]):
            reasons.append("限行时段：%s" % r.get("note", "%s-%s" % (r["from"], r["to"])))
    return (len(reasons) == 0), reasons


def height_check(lot: Dict[str, Any], vehicle: Optional[Dict[str, Any]]) -> tuple:
    """车辆限高不匹配 → 排除（04 §6：这一项可以真正判断）。"""
    limit = (lot.get("access") or {}).get("height_limit_m")
    if limit is None or not vehicle:
        return True, None
    vh = vehicle.get("height_m")
    if vh is None:
        return True, None
    if vh > limit:
        return False, "车辆高度 %.1f 米超过限高 %.1f 米" % (vh, limit)
    return True, None


def _in_hours(dt: datetime, frm: str, to: str) -> bool:
    cur = dt.hour * 60 + dt.minute
    lo = _hhmm(frm)
    hi = _hhmm(to)
    if lo <= hi:
        return lo <= cur < hi
    return cur >= lo or cur < hi


def _hhmm(s: str) -> int:
    h, m = s.strip().split(":")
    return int(h) * 60 + int(m)


# --------------------------------------------------------------------------- #
# 打分
# --------------------------------------------------------------------------- #
def score_lot(lot: Dict[str, Any], forecast: Dict[str, Any], preference: str):
    """返回 ``(score, breakdown)``。score = Σ contribution（2.21 逐项之和）。"""
    caps = RANKING_CAPS
    weights = RANKING_WEIGHTS.get(preference, RANKING_WEIGHTS["default"])
    total = int(lot["total_spaces"])

    arrive_free = forecast.get("point_free")
    free_rate = forecast.get("free_rate")
    if free_rate is None and arrive_free is not None:
        free_rate = arrive_free / float(total)
    walk_min = int(lot["walk_to_street"]["minutes"])
    walk_meters = int(lot["walk_to_street"]["meters"])
    fee_amount = compute_fee(lot["fee"], caps["stay_hours"])
    drive = float(caps["drive_minutes_estimate"])
    park = float(caps["park_minutes"])
    total_time = drive + park + walk_min
    confidence = confidence_from_forecast(forecast)
    restriction_penalty = float(caps["restriction_one_way_penalty"]) if (lot.get("access") or {}).get("one_way") else 0.0

    raws = {
        "arrive_free": float(arrive_free) if arrive_free is not None else None,
        "arrive_free_rate": free_rate,
        "walk_cost": float(walk_min),
        "total_time": total_time,
        "fee_cost": fee_amount,
        "confidence": confidence,
        "restriction_penalty": restriction_penalty,
    }
    norms = {
        "arrive_free": _clamp01((float(arrive_free) if arrive_free is not None else 0.0) / float(caps["need"])),
        "arrive_free_rate": _clamp01(float(free_rate) if free_rate is not None else 0.0),
        "walk_cost": 1.0 - _clamp01(walk_min / float(caps["walk_cap_min"])),
        "total_time": 1.0 - _clamp01(total_time / float(caps["total_cap_min"])),
        "fee_cost": (1.0 - _clamp01(fee_amount / float(caps["fee_cap_cny"]))) if fee_amount is not None else 0.5,
        "confidence": _clamp01(confidence),
        "restriction_penalty": restriction_penalty,
    }

    breakdown = []
    score = 0.0
    for k in FACTOR_ORDER:
        w = weights[k]
        norm = norms[k]
        contribution = w * norm * 100.0
        score += contribution
        breakdown.append({
            "factor": k,
            "weight": w,
            "raw": raws[k],
            "normalized": norm,
            "contribution": contribution,
        })

    return score, breakdown


def _bdict(breakdown: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {b["factor"]: b for b in breakdown}


def make_reasons(lot: Dict[str, Any], forecast: Dict[str, Any], breakdown: List[Dict[str, Any]]) -> List[str]:
    """确定性字符串模板（04 §4）。每个数字来自 score_breakdown 的 raw（2.22）。"""
    caps = RANKING_CAPS
    b = _bdict(breakdown)
    reasons: List[str] = []

    af = b["arrive_free"]["raw"]
    fr = b["arrive_free_rate"]["raw"]
    if af is not None:
        pct = round_half_up((float(fr) if fr is not None else 0.0) * 100.0)
        reasons.append("到达时预计余位 %d 个（约 %d%% 空置率），有位可停。" % (int(af), pct))
    else:
        reasons.append("该车场暂无可用余位预测，仅按步行距离与费用排序。")

    walk_min = int(b["walk_cost"]["raw"])
    walk_meters = int(lot["walk_to_street"]["meters"])
    reasons.append("停车后步行约 %d 分钟（%d 米）到街区入口。" % (walk_min, walk_meters))

    total_time = b["total_time"]["raw"]
    drive = int(caps["drive_minutes_estimate"])
    park = int(caps["park_minutes"])
    reasons.append("预计总时间约 %d 分钟（驾车估算 %d 分钟 + 步行 %d 分钟 + 停车 %d 分钟）。"
                  % (int(total_time), drive, walk_min, park))

    fee_amount = b["fee_cost"]["raw"]
    if fee_amount is not None:
        fee_mode = lot["fee"].get("mode")
        if fee_mode == "hourly":
            reasons.append("费用 %s 元/小时，按 %d 小时停留估算 %d 元。"
                          % (_fmt_num(lot["fee"]["amount"]), int(caps["stay_hours"]), round_half_up(fee_amount)))
        else:
            reasons.append("停车费约 %d 元。" % round_half_up(fee_amount))
    else:
        reasons.append("费用未知，建议以现场公示为准。")

    age = _age_seconds(forecast)
    conf = b["confidence"]["raw"]
    level = "较高" if conf >= 0.8 else ("中等" if conf >= 0.5 else "较低")
    if age is not None and age > 900:
        reasons.append("余位数据已过期（%d 分钟前），以现场为准。" % int(age // 60))
    elif age is not None:
        reasons.append("余位数据更新于 %d 分钟前，预测可信度%s。" % (int(age // 60), level))
    else:
        reasons.append("余位数据更新时间未知，预测可信度%s。" % level)

    if lot.get("notes"):
        reasons.append("注意：%s" % lot["notes"])
    if (lot.get("access") or {}).get("one_way"):
        note = (lot.get("access") or {}).get("note")
        if note:
            reasons.append("注意：%s" % note)

    return reasons


def _fmt_num(x: Optional[float]) -> str:
    if x is None:
        return "未知"
    r = round_half_up(x)
    if abs(x - r) < 1e-9:
        return str(r)
    return "%.1f" % x


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
def _clamp_horizon(minutes: int) -> int:
    horizon = int(round(minutes / 15.0) * 15)
    return max(15, min(60, horizon))


def recommend(dataset, model: Dict[str, Any], destination_id: str, arrive_at: datetime,
              preference: str = "save_time", vehicle: Optional[Dict[str, Any]] = None,
              travel_mode: str = "drive", generated_at: Optional[datetime] = None) -> Dict[str, Any]:
    """生成停车推荐（04 §1）。返回 schema 兼容 + ``excluded``/``offsets`` 扩展。"""
    if travel_mode != "drive":
        return {
            "destination_id": destination_id, "arrive_at": fmt_ts(arrive_at),
            "preference": preference, "generated_at": fmt_ts(generated_at or arrive_at),
            "items": [], "alternates": [], "excluded": [], "offsets": [],
            "source": "synthetic", "note": "步行抵达，无需停车",
        }

    stats = model.get("feature_fills") or default_stats()
    issued_at = generated_at or (arrive_at - timedelta(minutes=30))
    horizon = _clamp_horizon(int((arrive_at - issued_at).total_seconds() // 60))

    lots = {l["lot_id"]: l for l in dataset.lots}
    items: List[Dict[str, Any]] = []
    excluded: List[Dict[str, Any]] = []
    offsets: List[Dict[str, Any]] = []

    for lot_id, lot in lots.items():
        forecasts, f = T.forecast_lot(dataset, model, lot_id, issued_at, issued_at,
                                      horizons=[horizon], stats=stats)
        forecast = forecasts[0]

        # 硬过滤（04 §3.3）
        ok_access, access_reasons = access_check(lot, arrive_at)
        if not ok_access:
            excluded.append({"lot_id": lot_id, "name": lot["name"], "reason": "；".join(access_reasons)})
            continue
        ok_height, height_reason = height_check(lot, vehicle)
        if not ok_height:
            excluded.append({"lot_id": lot_id, "name": lot["name"], "reason": height_reason})
            continue
        if forecast.get("point_free") == 0:
            # 错峰方案（04 §3.4）
            offset_ok = _build_offsets(dataset, model, lot_id, lot, arrive_at, issued_at, stats, offsets)
            if not offset_ok:
                excluded.append({"lot_id": lot_id, "name": lot["name"],
                                 "reason": "到达时刻预计无余位，且无可行错峰方案"})
            continue

        score, breakdown = score_lot(lot, forecast, preference)
        reasons = make_reasons(lot, forecast, breakdown)
        items.append(_build_item(lot, forecast, breakdown, reasons, score))

    items.sort(key=lambda it: it["score"], reverse=True)
    alternates = items[1:]
    top = items[:1]
    return {
        "destination_id": destination_id,
        "arrive_at": fmt_ts(arrive_at),
        "preference": preference,
        "generated_at": fmt_ts(issued_at),
        "items": top,
        "alternates": alternates,
        "excluded": excluded,
        "offsets": offsets,
        "source": "synthetic",
    }


def _build_offsets(dataset, model, lot_id, lot, arrive_at, issued_at, stats, offsets) -> bool:
    ok = False
    for extra in (30, 60):
        target = arrive_at + timedelta(minutes=extra)
        h = _clamp_horizon(int((target - issued_at).total_seconds() // 60))
        fcs, _ = T.forecast_lot(dataset, model, lot_id, issued_at, issued_at, horizons=[h], stats=stats)
        if fcs[0].get("point_free") is not None and fcs[0]["point_free"] > 0:
            offsets.append({
                "lot_id": lot_id,
                "name": lot["name"],
                "arrive_at": "+%dmin" % extra,
                "arrive_free": fcs[0]["point_free"],
                "extra_minutes": extra,
                "note": "建议错峰 %d 分钟后到达，预计有余位" % extra,
            })
            ok = True
    return ok


def _build_item(lot, forecast, breakdown, reasons, score) -> Dict[str, Any]:
    fee_amount = compute_fee(lot["fee"], RANKING_CAPS["stay_hours"])
    return {
        "lot_id": lot["lot_id"],
        "name": lot["name"],
        "arrive_free": forecast.get("point_free"),
        "arrive_free_rate": forecast.get("free_rate"),
        "arrive_free_p10": forecast.get("p10"),
        "arrive_free_p90": forecast.get("p90"),
        "walk_meters": lot["walk_to_street"]["meters"],
        "walk_minutes": lot["walk_to_street"]["minutes"],
        "fee_amount": fee_amount,
        "fee_unit": lot["fee"].get("unit") if fee_amount is not None else None,
        "updated_at": forecast.get("data_asof"),
        "stale": _age_seconds(forecast) is not None and _age_seconds(forecast) > 900,
        "score": score,
        "score_breakdown": breakdown,
        "reasons": reasons,
        "total_time_minutes": RANKING_CAPS["drive_minutes_estimate"] + RANKING_CAPS["park_minutes"] + lot["walk_to_street"]["minutes"],
        "transfer": {"mode": None, "feasible": False, "minutes": None, "note": "暂无可用接驳点数据"},
        "restrictions": _restriction_notes(lot),
        "forecast_method": forecast.get("method"),
        "degraded": forecast.get("degraded"),
    }


def _restriction_notes(lot) -> List[str]:
    access = lot.get("access") or {}
    notes = []
    if access.get("one_way"):
        notes.append("单行")
    if access.get("note"):
        notes.append(access["note"])
    return notes
