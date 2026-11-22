# -*- coding: utf-8 -*-
"""讲解员服务能力画像：评价聚合、时段供给画像、服务能力综合分。"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

import pandas as pd

import config
from common import DATA_DIR, clamp, parse_ts, weekday_group

DIMENSIONS = ["accuracy", "expression", "attitude", "punctuality"]
DIM_COLS = {d: f"dim_{d}" for d in DIMENSIONS}
DIM_LABELS = {
    "accuracy": "讲解准确度",
    "expression": "表达",
    "attitude": "服务态度",
    "punctuality": "准时",
}

DEFAULT_NOW = "2026-11-22T12:00:00+08:00"


def load_reviews(path=None) -> pd.DataFrame:
    path = path or str(DATA_DIR / "reviews.csv")
    return pd.read_csv(path, encoding="utf-8")


def load_events(path=None) -> pd.DataFrame:
    path = path or str(DATA_DIR / "visitor_events.csv")
    return pd.read_csv(path, encoding="utf-8")


def aggregate_reviews(reviews: pd.DataFrame, person_id: str, now: str | None = None) -> dict:
    """聚合一位讲解员的评价：平均分、维度分、近 30 天趋势、评价量置信度。"""
    now_dt = parse_ts(now or DEFAULT_NOW)
    g = reviews[reviews["person_id"] == person_id].copy()
    n = int(len(g))
    if n == 0:
        return {
            "person_id": person_id, "rating_count": 0, "avg_rating": None,
            "dim_means": {d: None for d in DIMENSIONS},
            "recent30_avg": None, "historical_avg": None, "trend": None,
            "confidence": 0.0, "sample_sufficient": False,
        }

    g["_ts"] = g["ts"].apply(parse_ts)
    avg = float(g["rating"].mean())
    dims = {d: float(g[DIM_COLS[d]].mean()) for d in DIMENSIONS}

    cutoff = now_dt - timedelta(days=config.RECENT_WINDOW_DAYS)
    recent = g[g["_ts"] >= cutoff]
    hist = g[g["_ts"] < cutoff]
    recent_avg = float(recent["rating"].mean()) if len(recent) else None
    hist_avg = float(hist["rating"].mean()) if len(hist) else None
    trend = None
    if recent_avg is not None and hist_avg is not None:
        trend = round(recent_avg - hist_avg, 3)

    return {
        "person_id": person_id,
        "rating_count": n,
        "avg_rating": round(avg, 3),
        "dim_means": {d: round(dims[d], 3) for d in DIMENSIONS},
        "recent30_avg": None if recent_avg is None else round(recent_avg, 3),
        "historical_avg": None if hist_avg is None else round(hist_avg, 3),
        "trend": trend,
        "confidence": round(clamp(n / config.CONFIDENCE_MIN_COUNT), 3),
        "sample_sufficient": n >= config.CONFIDENCE_MIN_COUNT,
    }


def aggregate_all(reviews: pd.DataFrame, guides: list[dict]) -> dict[str, dict]:
    return {g["person_id"]: aggregate_reviews(reviews, g["person_id"]) for g in guides}


def slot_supply_profile(guides: list[dict]) -> dict:
    """按（星期 × 时段）统计每位讲解员的可用供给，并列出供给紧张时段。"""
    weekday_slot_guides: dict[tuple[str, str], set[str]] = defaultdict(set)
    per_guide: dict[str, dict] = {}
    for g in guides:
        by_weekday_slot: dict[tuple[str, str], int] = defaultdict(int)
        for d, times in g.get("available_slots", {}).items():
            wd = weekday_group(parse_ts(f"{d}T00:00:00+08:00"))
            for t in times:
                by_weekday_slot[(wd, t)] += 1
                weekday_slot_guides[(wd, t)].add(g["person_id"])
        per_guide[g["person_id"]] = {
            "slots": {f"{wd}|{t}": c for (wd, t), c in sorted(by_weekday_slot.items())}
        }

    tight_slots = [
        {
            "weekday": wd,
            "slot": t,
            "guide_count": len(gids),
            "guides": sorted(gids),
        }
        for (wd, t), gids in sorted(weekday_slot_guides.items())
        if len(gids) <= config.SUPPLY_TIGHT_THRESHOLD
    ]
    return {
        "weekday_slot_guide_count": {
            f"{wd}|{t}": len(gids) for (wd, t), gids in sorted(weekday_slot_guides.items())
        },
        "per_guide": per_guide,
        "tight_slots": tight_slots,
    }


def compute_repeat_rates(events: pd.DataFrame) -> dict[str, float]:
    """按游客行为计算每位讲解员的复约率（同一游客再次预约占比）。"""
    book = events[events["event_type"] == "book_guide"]
    seen: dict[str, set[str]] = defaultdict(set)
    total: dict[str, int] = defaultdict(int)
    repeat: dict[str, int] = defaultdict(int)
    for row in book.itertuples():
        g = row.guide_id
        v = row.visitor_id
        if not g:
            continue
        total[g] += 1
        if v in seen[g]:
            repeat[g] += 1
        seen[g].add(v)
    return {g: repeat[g] / total[g] for g in total}


def capability_score(stats: dict, repeat_rate: float = 0.0) -> dict:
    """服务能力综合分（0-1）。

    公式：
        raw = 0.35·(平均星级/5) + 0.25·(维度均分/5) + 0.20·(准时分/5) + 0.20·复约率
        score = clamp(raw) × confidence
    confidence 随评价量线性增长，评价数不足时整体降权并标注「样本不足」。
    """
    w = config.CAPABILITY_WEIGHTS
    rating_n = clamp((stats["avg_rating"] or 0.0) / 5.0)
    dims = stats["dim_means"]
    dim_mean = sum((dims[d] or 0.0) for d in DIMENSIONS) / len(DIMENSIONS)
    dims_n = clamp(dim_mean / 5.0)
    punct_n = clamp((dims["punctuality"] or 0.0) / 5.0)
    repeat_n = clamp(repeat_rate)
    raw = (w["rating"] * rating_n + w["dims"] * dims_n
           + w["punctuality"] * punct_n + w["repeat"] * repeat_n)
    score = round(clamp(raw) * stats["confidence"], 3)
    return {
        "person_id": stats["person_id"],
        "score": score,
        "components": {
            "rating": round(rating_n, 3),
            "dims": round(dims_n, 3),
            "punctuality": round(punct_n, 3),
            "repeat": round(repeat_n, 3),
        },
        "confidence": stats["confidence"],
        "sample_sufficient": stats["sample_sufficient"],
    }
