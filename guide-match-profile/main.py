# -*- coding: utf-8 -*-
"""讲解员智能匹配 + 游客兴趣画像 —— 演示入口。

运行：python guide-match-profile/main.py
打印：一次匹配查询（含理由）、一位讲解员能力画像、时段供给、可用时段与冲突、
      一次游客画像更新前后对比、代理指标；并把指标写入 metrics.json。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

# 保证中文输出在任何终端编码下都不报错
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import config
import evaluation
import matching
import profile as profile_mod
import visitor_profile
from common import DATA_DIR, load_json

PKG_DIR = Path(__file__).resolve().parent


def _json_safe(obj):
    """递归把 NaN/Inf、numpy 标量转为合法 JSON 值。"""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    if hasattr(obj, "item"):
        return _json_safe(obj.item())
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)


def _bar(title: str):
    print("\n" + "=" * 72)
    print(title)
    print("=" * 72)


def load_all():
    guides = load_json(DATA_DIR / "guides.json")
    points = load_json(DATA_DIR / "points.json")
    reviews = profile_mod.load_reviews()
    events = profile_mod.load_events()
    return guides, points, reviews, events


def demo_matching(ctx):
    _bar("1) 讲解员匹配查询（含硬过滤、加权打分与推荐理由）")
    query = {
        "visitor_id": "V0001",
        "device_lang": "普通话",
        "requested_languages": ["普通话"],
        "target_point_id": "LD006",
        "date": "2026-11-22",
        "time": "10:30",
    }
    point = ctx["points_by_id"]["LD006"]
    print(f"查询：目标点位 {point['name']}({point['point_id']})，"
          f"设备语言 {query['device_lang']}，日期 {query['date']} {query['time']}")
    top, scored, rejected = matching.match(query, ctx, top_n=3)
    print(f"硬过滤后候选 {len(scored)} 人，被拒 {len(rejected)} 人")
    if rejected:
        r = rejected[0]
        print(f"  示例被拒：{r['person_id']} -> {r['reason']}")
    for i, s in enumerate(top, 1):
        print(f"\n  Top{i}  {s['name']}({s['person_id']})  总分={s['score']}")
        print(f"    理由：" + "；".join(s["reasons"]))
        print(f"    子分：{json.dumps(s['subscores'], ensure_ascii=False)}")
    return top


def demo_capability(ctx, top):
    _bar("2) 讲解员服务能力画像（评价聚合 + 综合分）")
    pid = top[0]["person_id"]
    stats = profile_mod.aggregate_reviews(profile_mod.load_reviews(), pid)
    repeat = profile_mod.compute_repeat_rates(profile_mod.load_events()).get(pid, 0.0)
    cap = profile_mod.capability_score(stats, repeat)
    guide = ctx["guide_by_id"][pid]
    print(f"{guide['name']}({pid}) 评级 {guide['rating']} 评价 {stats['rating_count']} 条")
    print(f"  平均分 {stats['avg_rating']}；维度分 {json.dumps(stats['dim_means'], ensure_ascii=False)}")
    print(f"  近 30 天均分 {stats['recent30_avg']} vs 历史均分 {stats['historical_avg']}，"
          f"趋势 {stats['trend']}")
    print(f"  复约率 {round(repeat, 3)}；置信度 {stats['confidence']}"
          f"（{'样本充足' if stats['sample_sufficient'] else '样本不足'}）")
    print(f"  服务能力综合分 = {cap['score']}  分量 {json.dumps(cap['components'], ensure_ascii=False)}")


def demo_supply(ctx):
    _bar("3) 时段供给画像（旺季/淡季调度参考）")
    supply = profile_mod.slot_supply_profile(ctx["guides"])
    tight = supply["tight_slots"]
    print(f"供给紧张时段（可服务讲解员 ≤ {config.SUPPLY_TIGHT_THRESHOLD} 人）共 {len(tight)} 个：")
    for t in tight[:8]:
        print(f"  {t['weekday']} {t['slot']} -> {t['guide_count']} 人：{', '.join(t['guides'][:5])}")
    return supply


def demo_slots_and_reschedule(ctx):
    _bar("4) 可用时段查询 + 同一时段冲突检测 + 改约候选")
    date, time = "2026-11-22", "10:30"
    rows = matching.query_available_slots(date, time, ctx,
                                          requested_languages=["普通话"],
                                          device_lang="普通话")
    free = [r for r in rows if not r["conflict"]]
    conflict = [r for r in rows if r["conflict"]]
    print(f"{date} {time} 普通话可预约 {len(free)} 人；存在冲突（已满）{len(conflict)} 人")
    for r in free[:5]:
        print(f"  {r['name']}({r['person_id']}) 剩余名额 {r['remaining']}")
    # 改约候选：给一条已存在的预约找可改约时段
    bookings = ctx["bookings"]
    sample = next(((g, d, t) for (g, d, t) in bookings if g == "PV004"), None)
    if sample:
        gid, d, t = sample
        cands = matching.reschedule_candidates(gid, d, t, ctx)
        print(f"\n改约候选示例：{ctx['guide_by_id'][gid]['name']}({gid}) 原 {d} {t} ->")
        for c in cands:
            print(f"  {c['date']} {c['time']}（离原时段 {c['offset_minutes']} 分钟）")


def demo_visitor_profile(ctx):
    _bar("5) 游客兴趣画像增量更新（前后对比）")
    events = profile_mod.load_events()
    points_by_id = ctx["points_by_id"]
    guides_by_id = ctx["guide_by_id"]
    v = "V0001"
    sub = events[events["visitor_id"] == v].sort_values("ts")
    interesting = sub[sub["event_type"].isin(["arrive_point", "listen_guide", "ask_question"])]
    ev = (interesting.iloc[0] if len(interesting) else sub.iloc[0]).to_dict()
    before = visitor_profile.empty_profile(v, now=ev["ts"])
    tags_before = dict(before["interest_tags"])
    print(f"游客 {v}，示例事件：{ev['event_type']} @ {ev['point_id']} "
          f"tags={ev['interest_tags']} lang={ev['device_lang']}")
    print(f"更新前兴趣标签：{tags_before}")
    visitor_profile.update_profile(before, ev, points_by_id, guides_by_id, now=ev["ts"])
    print(f"更新后兴趣标签：{before['interest_tags']}")
    full = visitor_profile.build_profile(events, v, points_by_id, guides_by_id)
    print(f"\n完整画像（脱敏）兴趣 Top：{json.dumps(full['interest_tags'], ensure_ascii=False)}")
    ok, problems = visitor_profile.deidentify_ok(full)
    print(f"脱敏自检：{'通过' if ok else '未通过 ' + str(problems)}")
    return {"visitor_id": v, "event": ev,
            "before": tags_before, "after": before["interest_tags"],
            "final_interest_tags": full["interest_tags"]}


def build_metrics(ctx, events, profile_example, weights):
    metrics = {
        "algo_version": "guide-match-0.1.0",
        "weights": weights,
        "capability_weights": config.CAPABILITY_WEIGHTS,
        "event_weights": config.EVENT_WEIGHTS,
        "proxy_eval": evaluation.run_proxy_eval(ctx, events,
                                                evaluation.build_queries(events, ctx["guides"]),
                                                weights=weights),
        "booking_usage_rate": evaluation.booking_usage_rate(events),
        "avg_confirmation_minutes": evaluation.avg_confirmation_minutes(events),
        "profile_update_example": {
            "visitor_id": profile_example["visitor_id"],
            "event": profile_example["event"],
            "interest_tags_before": profile_example["before"],
            "interest_tags_after": profile_example["after"],
            "final_interest_tags": profile_example["final_interest_tags"],
        },
        "metrics_usage_note": (
            "booking_usage_rate(events) 与 avg_confirmation_minutes(events) 输入 "
            "visitor_events.csv 即可计算；当前为合成数据示例结果，"
            "「预约使用率≥30%」「平均确认时长≤30分钟」需线上真实埋点数据才能验收。"
        ),
        "data_source": "synthetic",
    }
    return metrics


def main():
    guides, points, reviews, events = load_all()
    ctx = matching.build_context(guides, points, reviews, events)

    top = demo_matching(ctx)
    demo_capability(ctx, top)
    demo_supply(ctx)
    demo_slots_and_reschedule(ctx)
    profile_example = demo_visitor_profile(ctx)

    _bar("6) 代理指标（合成数据，不代表真实达成）")
    metrics = build_metrics(ctx, events, profile_example, config.DEFAULT_WEIGHTS)
    pe = metrics["proxy_eval"]
    print(f"样本量 n={pe['n_queries']}（口径：真值=合成行为中游客实际预约的讲解员）")
    print(f"Top1 命中率：{pe['top1_hit_rate']}  基线(仅评级)：{pe['baseline_top1_hit_rate']}")
    print(f"Top3 覆盖率：{pe['top3_coverage']}  基线(仅评级)：{pe['baseline_top3_coverage']}")
    print(f"语种硬过滤正确率：{pe['language_filter_correctness']}")
    bu = metrics["booking_usage_rate"]
    print(f"预约使用率（合成）：{bu['booking_usage_rate']} "
          f"（{bu['n_bookers']}/{bu['n_visitors']} 游客，口径见 README）")
    ac = metrics["avg_confirmation_minutes"]
    print(f"平均确认时长（合成）：{ac['avg_confirmation_minutes']} 分钟 "
          f"（n={ac['n_confirmations']}，口径见 README）")

    out = PKG_DIR / "metrics.json"
    out.write_text(json.dumps(_json_safe(metrics), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入指标：{out}")


if __name__ == "__main__":
    main()
