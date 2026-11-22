# -*- coding: utf-8 -*-
"""游客兴趣画像：行为事件增量更新、行为→兴趣映射、画像输出与脱敏。"""
from __future__ import annotations

import re

import pandas as pd

import config
from common import parse_ts

# 脱敏检查：手机号（大陆 11 位）、身份证、姓名类键
_PHONE_RE = re.compile(r"1[3-9]\d{9}")
_IDCARD_RE = re.compile(r"\d{17}[\dXx]")
_PII_KEYS = {"name", "real_name", "phone", "mobile", "tel", "id_card", "idcard", "身份证"}


def empty_profile(visitor_id: str, now: str | None = None) -> dict:
    return {
        "visitor_id": visitor_id,
        "updated_at": now or "",
        "interest_tags": {},          # 标签 -> 累积权重
        "active_hours": {},           # 时段桶 -> 加权次数
        "languages": {},              # 语言 -> 加权次数
        "price_preference": {"band": None, "avg_booked_price": None, "bookings": 0},
        "visited_points": 0,
        "total_events": 0,
    }


def _hour_bucket(hour: int) -> str:
    for lo, hi in config.ACTIVE_HOUR_BUCKETS:
        if lo <= hour < hi:
            return f"{lo:02d}-{hi:02d}"
    return "other"


def _decay(age_days: float) -> float:
    return 0.5 ** (age_days / config.INTEREST_HALF_LIFE_DAYS)


def _interest_from_event(event, points_by_id: dict) -> list[str]:
    """行为 → 兴趣 映射（显式规则，见 config.EVENT_TAG_SOURCE 与 README）。"""
    source = config.EVENT_TAG_SOURCE.get(event["event_type"], "none")
    if source == "none":
        return []
    if source == "to_point":
        point = points_by_id.get(event.get("point_id") or "")
        return point["interest_tags"] if point else []
    if source == "event_tags":
        raw = event.get("interest_tags") or ""
        return [t for t in raw.split("|") if t]
    return []


def _price_band(price: float) -> str | None:
    for lo, hi, label in config.PRICE_BANDS:
        if lo <= price < hi:
            return label
    return None


def update_profile(profile: dict, event: dict, points_by_id: dict,
                   guides_by_id: dict | None = None, now: str | None = None) -> dict:
    """把一次行为事件按权重并入画像（原地更新并返回）。"""
    now_dt = parse_ts(now) if now else None
    ts = parse_ts(event["ts"])
    age_days = max(0.0, (now_dt - ts).days) if now_dt else 0.0
    decay = _decay(age_days)

    weight = config.EVENT_WEIGHTS.get(event["event_type"], 0.0)
    profile["total_events"] += 1
    profile["updated_at"] = now or event["ts"]

    # 兴趣标签：来源由映射规则决定，权重 = 事件权重 × 时间衰减
    for tag in _interest_from_event(event, points_by_id):
        profile["interest_tags"][tag] = round(
            profile["interest_tags"].get(tag, 0.0) + weight * decay, 4)

    # 活跃时段
    bucket = _hour_bucket(ts.hour)
    profile["active_hours"][bucket] = profile["active_hours"].get(bucket, 0.0) + 1.0

    # 常用语言（device_lang）
    lang = event.get("device_lang")
    if lang:
        profile["languages"][lang] = profile["languages"].get(lang, 0.0) + 1.0

    # 去过点位数（到达点位去重）
    if event["event_type"] == "arrive_point" and event.get("point_id"):
        profile["visited_points"] = len(
            set(profile.get("_visited", set())) | {event["point_id"]})
        profile.setdefault("_visited", set()).add(event["point_id"])

    # 消费/价位偏好：预约人工讲解时按讲解员价格统计
    if event["event_type"] == "book_guide" and event.get("guide_id") and guides_by_id:
        guide = guides_by_id.get(event["guide_id"])
        if guide and guide.get("price"):
            pp = profile["price_preference"]
            prev_total = pp["avg_booked_price"] or 0.0
            n = pp["bookings"]
            pp["bookings"] = n + 1
            pp["avg_booked_price"] = round((prev_total * n + guide["price"]) / (n + 1), 2)
            pp["band"] = _price_band(pp["avg_booked_price"])

    return profile


def finalize_profile(profile: dict) -> dict:
    """去掉内部字段、排序，产出可序列化的画像（不含任何可识别信息）。"""
    out = dict(profile)
    out.pop("_visited", None)
    out["interest_tags"] = dict(
        sorted(out["interest_tags"].items(), key=lambda kv: -kv[1]))
    out["active_hours"] = dict(sorted(out["active_hours"].items()))
    out["languages"] = dict(sorted(out["languages"].items(), key=lambda kv: -kv[1]))
    return out


def build_profile(events: pd.DataFrame, visitor_id: str, points_by_id: dict,
                  guides_by_id: dict | None = None, now: str | None = None) -> dict:
    """按游客 ID 聚合全部行为，返回最终画像。"""
    profile = empty_profile(visitor_id, now=now)
    sub = events[events["visitor_id"] == visitor_id].sort_values("ts")
    for row in sub.itertuples():
        update_profile(profile, row._asdict(), points_by_id, guides_by_id, now=now)
    return finalize_profile(profile)


def deidentify_ok(profile: dict) -> tuple[bool, list[str]]:
    """脱敏自检：输出不得含姓名、手机号、身份证等可识别信息；visitor_id 保持匿名。"""
    problems = []
    text = _flatten(profile)
    if _PHONE_RE.search(text):
        problems.append("包含手机号")
    if _IDCARD_RE.search(text):
        problems.append("包含身份证号")
    for k in profile.keys():
        if k in _PII_KEYS:
            problems.append(f"包含 PII 字段 {k}")
    vid = profile.get("visitor_id", "")
    if not re.fullmatch(r"V\d{4,}", vid):
        problems.append("visitor_id 非匿名格式")
    return (len(problems) == 0), problems


def _flatten(obj) -> str:
    parts = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            parts.append(str(k))
            parts.append(_flatten(v))
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            parts.append(_flatten(v))
    else:
        parts.append(str(obj))
    return " ".join(parts)
