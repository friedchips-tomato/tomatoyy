# -*- coding: utf-8 -*-
"""guide-match-profile 包内公共工具（仅标准库，不 import 其它 algo 包）。"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 业务时区：北京时间 UTC+8（需求书与契约规定）
CST = timezone(timedelta(hours=8))

PKG_DIR = Path(__file__).resolve().parent
DATA_DIR = PKG_DIR / "data"


def parse_ts(ts: str) -> datetime:
    """解析 ISO 8601 时间字符串；无时区时按北京时间处理。"""
    dt = datetime.fromisoformat(ts)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=CST)
    return dt


def load_json(path: str | Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def hhmm_to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def minutes_to_hhmm(total: int) -> str:
    total = max(0, min(total, 24 * 60 - 1))
    return f"{total // 60:02d}:{total % 60:02d}"


def weekday_group(d: datetime) -> str:
    """返回契约口径的星期分组：mon_fri 或 sat_sun。"""
    return "sat_sun" if d.weekday() >= 5 else "mon_fri"


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """两点球面距离（米），坐标统一 WGS84。"""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def slot_in_ranges(hhmm: str, ranges: list[str]) -> bool:
    """判断 HH:MM 是否落在某日班的 [start, end) 区间内。"""
    t = hhmm_to_minutes(hhmm)
    for r in ranges:
        start, end = r.split("-")
        s, e = hhmm_to_minutes(start), hhmm_to_minutes(end)
        if s <= t < e:
            return True
    return False
