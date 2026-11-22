# -*- coding: utf-8 -*-
"""讲解员多条件匹配与排序：硬过滤 + 加权打分 + 推荐理由 + 时段查询 + 改约候选。"""
from __future__ import annotations

import math
from collections import Counter
from datetime import timedelta

import config
from common import clamp, haversine_m, hhmm_to_minutes, parse_ts, slot_in_ranges, weekday_group


# ---------------------------------------------------------------------------
# 硬过滤：语种 / 服务范围 / 当日在班 / 预约时段可用（含同段冲突）
# ---------------------------------------------------------------------------
def language_filter(guide: dict, query: dict):
    """语种硬过滤：设备语言与请求语种都必须包含在讲解员 languages 内。"""
    langs = set(guide.get("languages", []))
    device = query.get("device_lang")
    if device and device not in langs:
        return False, f"语种不符：不支持设备语言 {device}"
    for r in (query.get("requested_languages") or []):
        if r not in langs:
            return False, f"语种不符：不支持请求语种 {r}"
    return True, None


def range_filter(guide: dict, point: dict):
    """服务范围硬过滤：目标点位在 service_point_ids 内，或在 service_radius_m 覆盖内。"""
    pid = point["point_id"]
    dist = haversine_m(
        guide["location"]["latitude"], guide["location"]["longitude"],
        point["latitude"], point["longitude"],
    )
    if pid in guide.get("service_point_ids", []):
        return True, dist, None
    radius = guide.get("service_radius_m", 0)
    if dist <= radius:
        return True, dist, None
    return False, dist, f"超出服务范围（距 {int(dist)} 米 > {radius} 米）"


def duty_filter(guide: dict, date_str: str, time_str: str):
    """当日在班硬过滤：按星期分组检查 service_hours 是否覆盖该时段。"""
    wg = weekday_group(parse_ts(f"{date_str}T00:00:00+08:00"))
    ranges = guide.get("service_hours", {}).get(wg)
    if not ranges:
        return False, f"{wg} 不在班"
    if not slot_in_ranges(time_str, ranges):
        return False, f"时段 {time_str} 不在服务时间 {ranges}"
    return True, None


def slot_filter(guide: dict, date_str: str, time_str: str, bookings: dict):
    """预约时段硬过滤：available_slots 有该时段，且该讲解员同一时段未被占满。"""
    slots = guide.get("available_slots", {}).get(date_str, [])
    if time_str not in slots:
        return False, f"{date_str} {time_str} 不可预约"
    cap = guide.get("capacity_per_slot", 1)
    if bookings.get((guide["person_id"], date_str, time_str), 0) >= cap:
        return False, "该时段已被预约（同一讲解员同一时段仅一单）"
    return True, None


def hard_filter_reason(guide: dict, query: dict, point: dict, bookings: dict):
    """依次执行四条硬过滤，返回 None 表示通过，否则返回被拒原因。"""
    ok, reason = language_filter(guide, query)
    if not ok:
        return reason
    ok, dist, reason = range_filter(guide, point)
    if not ok:
        return reason
    ok, reason = duty_filter(guide, query["date"], query["time"])
    if not ok:
        return reason
    ok, reason = slot_filter(guide, query["date"], query["time"], bookings)
    if not ok:
        return reason
    return None


# ---------------------------------------------------------------------------
# 加权打分（权重见 config.DEFAULT_WEIGHTS，可通过参数覆盖）
# ---------------------------------------------------------------------------
def _lang_score(guide: dict, query: dict) -> float:
    device = query.get("device_lang")
    reqs = query.get("requested_languages") or []
    return config.LANG_NATIVE if (device and device in reqs) else config.LANG_SERVABLE


def _rating_score(guide: dict) -> float:
    return clamp(guide.get("rating", 0.0) / 5.0)


def _distance_score(guide: dict, point: dict, dist: float) -> float:
    if point["point_id"] in guide.get("service_point_ids", []):
        return 1.0
    radius = guide.get("service_radius_m", 1) or 1
    return clamp(1.0 - dist / radius)


def _slot_fit_score(guide: dict, date_str: str, bookings: dict) -> float:
    slots = guide.get("available_slots", {}).get(date_str, [])
    total = len(slots)
    booked = sum(bookings.get((guide["person_id"], date_str, t), 0) for t in slots)
    free = max(0, total - booked)
    headroom = free / max(1, total)
    return config.SLOT_FIT_EXACT_W * 1.0 + config.SLOT_FIT_HEADROOM_W * headroom


def _price_score(guide: dict, mean_price: float) -> float:
    if mean_price <= 0:
        return 0.5
    dev = abs(guide.get("price", mean_price) - mean_price) / mean_price
    return clamp(1.0 - dev)


def _review_trend_score(stats: dict | None) -> float:
    if not stats or not stats.get("rating_count"):
        return 0.5
    volume = math.log1p(stats["rating_count"]) / math.log1p(config.REVIEW_COUNT_REF)
    trend = stats.get("trend") or 0.0
    trend_norm = clamp((trend + config.TREND_CLAMP) / (2 * config.TREND_CLAMP))
    base = (config.REVIEW_TREND_VOLUME_W * volume
            + config.REVIEW_TREND_DELTA_W * trend_norm)
    return clamp(base * stats.get("confidence", 1.0))


def _load_score(guide: dict, date_str: str, bookings: dict) -> float:
    slots = guide.get("available_slots", {}).get(date_str, [])
    total = len(slots)
    booked = sum(bookings.get((guide["person_id"], date_str, t), 0) for t in slots)
    return clamp(1.0 - (booked / max(1, total)))


def score_guide(guide: dict, query: dict, point: dict, bookings: dict,
                stats: dict | None, mean_price: float, weights: dict | None = None) -> dict:
    """对一位已通过硬过滤的讲解员打分，返回各子分、总分与中文推荐理由。"""
    w = weights or config.DEFAULT_WEIGHTS
    dist = haversine_m(
        guide["location"]["latitude"], guide["location"]["longitude"],
        point["latitude"], point["longitude"],
    )
    subs = {
        "language_match": _lang_score(guide, query),
        "rating": _rating_score(guide),
        "distance": _distance_score(guide, point, dist),
        "slot_fit": _slot_fit_score(guide, query["date"], bookings),
        "price_deviation": _price_score(guide, mean_price),
        "review_trend": _review_trend_score(stats),
        "load_balance": _load_score(guide, query["date"], bookings),
    }
    total = round(sum(w[k] * subs[k] for k in w), 4)

    reasons = _build_reasons(guide, query, point, dist, stats, mean_price, bookings)
    return {
        "person_id": guide["person_id"],
        "name": guide["name"],
        "score": total,
        "subscores": {k: round(v, 3) for k, v in subs.items()},
        "reasons": reasons,
        "language_match": True,
        "distance_m": round(dist),
        "slot": f"{query['date']}T{query['time']}:00+08:00",
        "price": guide.get("price"),
    }


def _build_reasons(guide, query, point, dist, stats, mean_price, bookings):
    reasons = []
    device = query.get("device_lang")
    reqs = query.get("requested_languages") or []
    langs = []
    for x in ([device] + reqs):
        if x and x not in langs:
            langs.append(x)
    lang_text = "、".join(langs) or "未指定"
    reasons.append(f"语种匹配：{lang_text}")

    rating = guide.get("rating")
    if rating is not None:
        reasons.append(f"评级 {rating}，评价 {guide.get('rating_count', 0)} 条")

    if point["point_id"] in guide.get("service_point_ids", []):
        reasons.append(f"官方服务点位：{point['name']}")
    else:
        reasons.append(f"距目标点位 {round(dist)} 米（服务半径 {guide.get('service_radius_m')} 米）")

    reasons.append(f"该时段可预约（{query['time']}）")

    if mean_price > 0:
        reasons.append(f"价格 {guide.get('price')} 元，接近均价 {round(mean_price)} 元")

    if stats and stats.get("rating_count"):
        trend = stats.get("trend")
        if trend is None:
            trend_text = "暂无近 30 天数据"
        elif trend > 0.01:
            trend_text = f"近 30 天趋势上升 +{trend}"
        elif trend < -0.01:
            trend_text = f"近 30 天趋势下降 {trend}"
        else:
            trend_text = "近 30 天趋势平稳"
        reasons.append(f"{trend_text}；评价 {stats['rating_count']} 条"
                       + ("" if stats["sample_sufficient"] else "（样本不足）"))

    return reasons[:3]


# ---------------------------------------------------------------------------
# 匹配主流程
# ---------------------------------------------------------------------------
def eligible_guides(query: dict, ctx: dict):
    """返回 (通过硬过滤的讲解员列表, 被拒记录列表)。"""
    point = ctx["points_by_id"][query["target_point_id"]]
    eligible, rejected = [], []
    for g in ctx["guides"]:
        reason = hard_filter_reason(g, query, point, ctx["bookings"])
        if reason is None:
            eligible.append(g)
        else:
            rejected.append({"person_id": g["person_id"], "reason": reason})
    return eligible, rejected


def match(query: dict, ctx: dict, top_n: int = 3, weights: dict | None = None):
    """返回 (TopN 推荐, 全部打分结果, 被拒记录)。"""
    point = ctx["points_by_id"][query["target_point_id"]]
    eligible, rejected = eligible_guides(query, ctx)
    mean_price = _mean_price(ctx["guides"])
    scored = [
        score_guide(g, query, point, ctx["bookings"], ctx["stats"].get(g["person_id"]),
                    mean_price, weights)
        for g in eligible
    ]
    scored.sort(key=lambda s: (-s["score"], -ctx["guide_by_id"][s["person_id"]]["rating"]))
    return scored[:top_n], scored, rejected


def _mean_price(guides: list[dict]) -> float:
    prices = [g.get("price", 0) for g in guides if g.get("price")]
    return sum(prices) / len(prices) if prices else 0.0


# ---------------------------------------------------------------------------
# 可用时段查询与改约候选
# ---------------------------------------------------------------------------
def query_available_slots(date_str: str, time_str: str, ctx: dict,
                          requested_languages=None, device_lang=None):
    """按日期 + 时段返回可预约的讲解员与剩余名额，检测同一时段冲突。"""
    results = []
    for g in ctx["guides"]:
        slots = g.get("available_slots", {}).get(date_str, [])
        if time_str and time_str not in slots:
            continue
        if requested_languages or device_lang:
            ok, _ = language_filter(
                g, {"device_lang": device_lang, "requested_languages": requested_languages or []})
            if not ok:
                continue
        cap = g.get("capacity_per_slot", 1)
        if time_str:
            booked = ctx["bookings"].get((g["person_id"], date_str, time_str), 0)
            remaining = cap - booked
            results.append({
                "person_id": g["person_id"], "name": g["name"],
                "date": date_str, "time": time_str,
                "remaining": remaining,
                "conflict": remaining <= 0,
                "languages": g["languages"],
            })
        else:
            for t in slots:
                booked = ctx["bookings"].get((g["person_id"], date_str, t), 0)
                remaining = cap - booked
                results.append({
                    "person_id": g["person_id"], "name": g["name"],
                    "date": date_str, "time": t,
                    "remaining": remaining,
                    "conflict": remaining <= 0,
                    "languages": g["languages"],
                })
    results.sort(key=lambda r: (r["conflict"], r["person_id"], r["time"]))
    return results


def reschedule_candidates(guide_id: str, orig_date: str, orig_time: str, ctx: dict,
                          window_days: int | None = None, top_n: int = 5):
    """改约候选：离原时段最近且空闲的可预约时段（不实现完整改约流程）。"""
    window_days = window_days if window_days is not None else config.RESCHEDULE_WINDOW_DAYS
    g = ctx["guide_by_id"].get(guide_id)
    if not g:
        return []
    cap = g.get("capacity_per_slot", 1)
    orig_dt = parse_ts(f"{orig_date}T00:00:00+08:00")
    orig_min = hhmm_to_minutes(orig_time)
    cands = []
    for delta in range(-window_days, window_days + 1):
        d = (orig_dt + timedelta(days=delta)).date().isoformat()
        for t in g.get("available_slots", {}).get(d, []):
            if ctx["bookings"].get((guide_id, d, t), 0) >= cap:
                continue
            day_diff = (parse_ts(f"{d}T00:00:00+08:00").date() - orig_dt.date()).days
            offset = abs(day_diff * 24 * 60 + (hhmm_to_minutes(t) - orig_min))
            cands.append({"date": d, "time": t, "offset_minutes": offset})
    cands.sort(key=lambda c: c["offset_minutes"])
    return cands[:top_n]


# ---------------------------------------------------------------------------
# 上下文构建
# ---------------------------------------------------------------------------
def build_bookings(events) -> dict:
    """从游客行为中的 book_guide 事件构建（讲解员, 日期, 时段）-> 已约单数。"""
    bookings = Counter()
    for row in events.itertuples():
        if row.event_type == "book_guide" and row.guide_id:
            ts = parse_ts(row.ts)
            bookings[(row.guide_id, ts.date().isoformat(), ts.strftime("%H:%M"))] += 1
    return dict(bookings)


def build_context(guides: list[dict], points: list[dict], reviews, events,
                  bookings: dict | None = None) -> dict:
    """组装匹配上下文：点位索引、讲解员索引、评价聚合、时段占用。"""
    import profile  # 包内模块，非其它 algo 包

    points_by_id = {p["point_id"]: p for p in points}
    guide_by_id = {g["person_id"]: g for g in guides}
    stats = profile.aggregate_all(reviews, guides)
    if bookings is None:
        bookings = build_bookings(events)
    return {
        "guides": guides,
        "points_by_id": points_by_id,
        "guide_by_id": guide_by_id,
        "stats": stats,
        "bookings": bookings,
    }
