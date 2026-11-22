# -*- coding: utf-8 -*-
"""代理评估与指标计算函数。

- 匹配效果代理评估：以合成行为里游客真实预约的讲解员为「真值（显示偏好）」，
  对比推荐 Top1 命中率、Top3 覆盖率，并与「仅按评级排序」的基线对比。
- 预约使用率 / 平均确认时长：提供指标计算函数（输入 visitor_events.csv 即可算），
  用合成数据给出一次示例计算，结果不代表真实达成。
"""
from __future__ import annotations

import json

import pandas as pd

import matching
from common import DATA_DIR, parse_ts


def build_queries(events: pd.DataFrame, guides: list[dict]) -> list[dict]:
    """从 book_guide 事件构造查询集：显示偏好（真值）= 游客实际预约的讲解员。"""
    guide_by_id = {g["person_id"]: g for g in guides}
    queries = []
    book = events[events["event_type"] == "book_guide"]
    for row in book.itertuples():
        if not row.guide_id:
            continue
        ts = parse_ts(row.ts)
        # 兜底：若事件未带点位，用该讲解员首个服务点位
        point_id = row.point_id or guide_by_id[row.guide_id]["service_point_ids"][0]
        queries.append({
            "query_id": f"Q{len(queries) + 1:03d}",
            "visitor_id": row.visitor_id,
            "device_lang": row.device_lang,
            "requested_languages": [row.device_lang],
            "target_point_id": point_id,
            "date": ts.date().isoformat(),
            "time": ts.strftime("%H:%M"),
            "ground_truth": row.guide_id,
        })
    return queries


def _baseline_rank(query: dict, ctx: dict) -> list[str]:
    """基线：仅按评级降序，只做语种硬过滤（不做服务范围/在班/时段/负载约束）。"""
    eligible = [g for g in ctx["guides"] if matching.language_filter(g, query)[0]]
    eligible.sort(key=lambda g: (-g.get("rating", 0.0), g["person_id"]))
    return [g["person_id"] for g in eligible]


def run_proxy_eval(ctx: dict, events: pd.DataFrame, queries: list[dict],
                   weights: dict | None = None) -> dict:
    """返回代理指标：Top1 命中率、Top3 覆盖率、语种硬过滤正确率，及基线对比。"""
    n = len(queries)
    top1_hit = top3_hit = 0
    top1_base = top3_base = 0
    lang_pairs = 0
    lang_ok = 0
    non_empty = 0
    examples = []

    for q in queries:
        # 预测时刻：排除该游客自己的这条预约（否则讲解员该时段被占满，无法复现推荐）
        key = (q["ground_truth"], q["date"], q["time"])
        bookings = dict(ctx["bookings"])
        if bookings.get(key, 0) > 0:
            bookings[key] -= 1
            if bookings[key] <= 0:
                del bookings[key]
        c = dict(ctx)
        c["bookings"] = bookings

        top, scored, _ = matching.match(q, c, top_n=3, weights=weights)
        if scored:
            non_empty += 1
        rec_ids = [s["person_id"] for s in scored]
        top_ids = [s["person_id"] for s in top]

        if q["ground_truth"] in rec_ids:
            top1_hit += int(top_ids[0] == q["ground_truth"])
            top3_hit += int(q["ground_truth"] in top_ids)

        base_ids = _baseline_rank(q, c)
        top1_base += int(base_ids[0] == q["ground_truth"]) if base_ids else 0
        top3_base += int(q["ground_truth"] in base_ids[:3])

        # 语种硬过滤正确率：所有返回推荐都必须包含设备语言与请求语种
        for s in scored:
            lang_pairs += 1
            if matching.language_filter(ctx["guide_by_id"][s["person_id"]], q)[0]:
                lang_ok += 1

        if len(examples) < 3:
            examples.append({
                "query_id": q["query_id"],
                "ground_truth": q["ground_truth"],
                "top1": top_ids[0] if top_ids else None,
                "top3": top_ids,
                "baseline_top1": base_ids[0] if base_ids else None,
            })

    return {
        "n_queries": n,
        "top1_hit_rate": round(top1_hit / n, 3) if n else None,
        "top3_coverage": round(top3_hit / n, 3) if n else None,
        "baseline_top1_hit_rate": round(top1_base / n, 3) if n else None,
        "baseline_top3_coverage": round(top3_base / n, 3) if n else None,
        "language_filter_correctness": round(lang_ok / lang_pairs, 3) if lang_pairs else None,
        "eligible_nonempty_rate": round(non_empty / n, 3) if n else None,
        "examples": examples,
        "note": "真值=合成行为中游客实际预约的讲解员（显示偏好），样本为合成数据，不代表真实效果。",
    }


def booking_usage_rate(events: pd.DataFrame) -> dict:
    """预约使用率口径：分子=至少一次 book_guide 的去重游客数；分母=去重游客总数。"""
    visitors = set(events["visitor_id"])
    bookers = set(events[events["event_type"] == "book_guide"]["visitor_id"])
    rate = len(bookers) / len(visitors) if visitors else 0.0
    return {
        "booking_usage_rate": round(rate, 4),
        "n_visitors": len(visitors),
        "n_bookers": len(bookers),
        "denominator": "去重游客总数",
        "numerator": "至少一次 book_guide 的去重游客数",
    }


def avg_confirmation_minutes(events: pd.DataFrame) -> dict:
    """平均预约确认时长口径：book_guide(提交) → book_confirmed(确认) 的分钟差。

    同一 (visitor, guide) 按时间 FIFO 配对；返回分钟均值与样本数。
    """
    lat = []
    pending: dict[tuple, list] = {}
    for row in events.sort_values("ts").itertuples():
        if row.event_type == "book_guide":
            pending.setdefault((row.visitor_id, row.guide_id), []).append(parse_ts(row.ts))
        elif row.event_type == "book_confirmed":
            key = (row.visitor_id, row.guide_id)
            if pending.get(key):
                book_ts = pending[key].pop(0)
                lat.append((parse_ts(row.ts) - book_ts).total_seconds() / 60.0)
    mean = sum(lat) / len(lat) if lat else None
    return {
        "avg_confirmation_minutes": round(mean, 2) if mean is not None else None,
        "n_confirmations": len(lat),
        "over_30min_ratio": round(sum(1 for x in lat if x > 30) / len(lat), 4) if lat else None,
        "note": "口径：book_guide 提交时刻到 book_confirmed 确认时刻的分钟差均值；"
                "需线上真实确认时间戳才能验收 ≤30 分钟目标。",
    }


def compute_all_metrics(ctx: dict, events: pd.DataFrame,
                        weights: dict | None = None) -> dict:
    queries = build_queries(events, ctx["guides"])
    return {
        "proxy_eval": run_proxy_eval(ctx, events, queries, weights=weights),
        "booking_usage_rate": booking_usage_rate(events),
        "avg_confirmation_minutes": avg_confirmation_minutes(events),
    }


def write_metrics(metrics: dict, path=None):
    path = path or str(DATA_DIR.parent / "metrics.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)
    return path
