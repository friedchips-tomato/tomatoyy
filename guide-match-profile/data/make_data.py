# -*- coding: utf-8 -*-
"""示范数据生成脚本（仅标准库，固定随机种子，可复现）。

生成 `points.json / guides.json / reviews.csv / visitor_events.csv`。
所有数据均为**合成示例**（data_source=synthetic，verified=false），
不含真实人物、真实评价或任何可识别个人信息；坐标、评级、时段均为示意。

运行：`python guide-match-profile/data/make_data.py`
生成结果已提交到 `data/`，测试与 main.py 直接读取这些文件，不依赖本脚本。
"""
from __future__ import annotations

import csv
import json
import math
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

CST = timezone(timedelta(hours=8))
SEED = 20261122
HERE = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# 点位（12 个，LD 前缀按契约；坐标为江门长堤一带 WGS84 示意，待现场核实）
# ---------------------------------------------------------------------------
POINTS = [
    ("LD001", "蓬江大桥（示例）", "街景节点", 113.0940, 22.5810, ["建筑", "摄影"]),
    ("LD002", "启明里（示例）", "历史建筑", 113.0860, 22.5820, ["历史", "建筑", "侨乡"]),
    ("LD003", "江门海关旧址（示例）", "历史建筑", 113.0890, 22.5790, ["历史", "建筑"]),
    ("LD004", "江门市博物馆长堤分馆（示例）", "文化场馆", 113.0910, 22.5770, ["历史", "建筑", "非遗"]),
    ("LD005", "水埠头石阶（示例）", "街景节点", 113.0920, 22.5760, ["历史", "摄影"]),
    ("LD006", "堤东路骑楼（示例）", "历史建筑", 113.0900, 22.5750, ["建筑", "历史", "摄影"]),
    ("LD007", "新市路（示例）", "街景节点", 113.0880, 22.5740, ["历史", "建筑", "摄影"]),
    ("LD008", "墟顶老街（示例）", "街景节点", 113.0850, 22.5745, ["历史", "侨乡"]),
    ("LD009", "沿江停车场（示例）", "公共服务", 113.0930, 22.5730, ["亲子", "摄影"]),
    ("LD010", "江门铁桥（示例）", "街景节点", 113.0830, 22.5720, ["历史", "摄影"]),
    ("LD011", "非遗体验空间（示例）", "非遗业态", 113.0870, 22.5765, ["非遗", "侨乡"]),
    ("LD012", "侨乡咖啡老店（示例）", "餐饮", 113.0895, 22.5755, ["美食", "侨乡"]),
]

POINT_NAMES = {p[0]: p[1] for p in POINTS}

# 24 位讲解员的语种（下标对应 讲解员A..X；刻意保留无普通话的讲解员以便语种硬过滤测试）
LANGUAGES = [
    ["普通话", "粤语", "English"],
    ["普通话", "粤语"],
    ["普通话", "粤语"],
    ["普通话", "English"],
    ["普通话", "粤语"],
    ["粤语", "English"],
    ["普通话", "粤语"],
    ["普通话", "粤语", "客家话"],
    ["普通话", "粤语"],
    ["普通话", "English"],
    ["普通话", "粤语"],
    ["粤语", "客家话"],
    ["普通话", "粤语", "English"],
    ["普通话", "粤语"],
    ["普通话", "粤语"],
    ["粤语", "English"],
    ["普通话", "粤语"],
    ["普通话", "English"],
    ["普通话", "粤语", "客家话"],
    ["普通话", "粤语"],
    ["普通话", "粤语"],
    ["普通话", "粤语", "English"],
    ["普通话", "粤语"],
    ["粤语", "客家话"],
]

LEVELS = ["金牌", "银牌", "银牌", "铜牌"]  # 权重分布
TOPICS_POOL = ["骑楼建筑", "侨乡历史", "开埠历史", "老街生活", "非遗技艺", "外语讲解", "方言故事", "影视取景"]

REVIEW_TEXT_POOL = [
    "讲解清晰，条理清楚。",
    "对骑楼历史讲得很详细。",
    "语速适中，重点突出。",
    "对小朋友很有耐心。",
    "路线安排合理，节奏舒服。",
    "讲了开埠历史，收获很大。",
    "建筑细节讲得到位。",
    "态度热情，有问必答。",
    "准时到场，服务专业。",
    "对侨乡文化很熟悉。",
    "整体满意，会推荐给朋友。",
    "个别年份讲得有点笼统。",
    "集合地点好找，指引清楚。",
    "讲解生动有趣。",
]

SLOT_DATES = ["2026-11-22", "2026-11-23", "2026-11-28", "2026-11-29"]  # 周日/周一/周六/周日


def _slots_within(ranges, rng):
    """在若干 [start,end) 区间内采样整点/半点时段。"""
    cand = []
    for r in ranges:
        s, e = r.split("-")
        sh, sm = map(int, s.split(":"))
        eh, em = map(int, e.split(":"))
        t = sh * 60 + sm
        end = eh * 60 + em
        while t < end:
            cand.append(f"{t // 60:02d}:{t % 60:02d}")
            t += 30
    return rng.sample(cand, k=min(len(cand), rng.randint(1, 4)))


def _on_duty(service_hours, d: date):
    key = "sat_sun" if d.weekday() >= 5 else "mon_fri"
    return service_hours.get(key)


def make_points():
    out = []
    for pid, name, cat, lng, lat, tags in POINTS:
        out.append({
            "point_id": pid, "name": name, "category": cat,
            "longitude": lng, "latitude": lat, "coord_system": "WGS84",
            "opening_hours": {"mon_fri": "09:00-17:00", "sat_sun": "09:00-18:00", "closed_days": []},
            "visit_minutes": 20, "interest_tags": tags, "style_tags": [],
            "crowd_level": "low", "description": "示例点位，坐标与名称待现场核实",
            "history_id": None, "kg_id": None, "guide_content_id": None,
            "image_refs": [], "data_source": "synthetic", "verified": False,
        })
    return out


def make_guides(rng):
    guides = []
    for i, langs in enumerate(LANGUAGES):
        pid = f"PV{i + 1:03d}"
        name = f"讲解员{chr(ord('A') + i)}"
        level = rng.choices(LEVELS, weights=[2, 3, 3, 2])[0]
        if level == "金牌":
            rating = round(rng.uniform(4.7, 4.9), 1)
        elif level == "银牌":
            rating = round(rng.uniform(4.4, 4.6), 1)
        else:
            rating = round(rng.uniform(4.0, 4.4), 1)
        # 少数讲解员评价数较少，用于触发"样本不足"
        rating_count = rng.choice([
            rng.randint(8, 29), rng.randint(30, 90), rng.randint(90, 180),
        ])
        base = POINTS[i % len(POINTS)]
        lo = max(0, (i % len(POINTS)) - 1)
        hi = min(len(POINTS), (i % len(POINTS)) + 2)
        service_point_ids = [p[0] for p in POINTS[lo:hi]]
        service_radius_m = rng.choice([600, 800, 1000, 1500])
        jitter = lambda v: round(v + rng.uniform(-0.002, 0.002), 4)
        location = {"longitude": jitter(base[3]), "latitude": jitter(base[4]), "coord_system": "WGS84"}
        service_hours = {"mon_fri": ["09:00-12:00", "14:00-18:00"]}
        if rng.random() < 0.7:
            service_hours["sat_sun"] = ["09:00-18:00"]
        elif rng.random() < 0.5:
            service_hours["sat_sun"] = ["09:00-12:00"]
        price = rng.choice([120, 150, 180, 200, 240, 280, 320, 400])
        available_slots = {}
        for d in SLOT_DATES:
            ranges = _on_duty(service_hours, date.fromisoformat(d))
            if ranges:
                available_slots[d] = sorted(_slots_within(ranges, rng))
        guides.append({
            "person_id": pid, "name": name, "languages": langs,
            "rating": rating, "rating_count": rating_count,
            "level": level,
            "topics": rng.sample(TOPICS_POOL, k=2),
            "service_point_ids": service_point_ids,
            "service_radius_m": service_radius_m,
            "location": location,
            "service_hours": service_hours,
            "price": price,
            "bio": f"{name}，{level}讲解员，熟悉长堤风貌街（示例数据）。",
            "available_slots": available_slots,
            "capacity_per_slot": 1,
            "data_source": "synthetic",
            "verified": False,
        })
    return guides


def _slot_ts(d: str, t: str) -> str:
    return f"{d}T{t}:00+08:00"


def _round3(x):
    return round(x + 1e-9, 3)


def make_reviews(guides, rng):
    rows = []
    now = datetime(2026, 11, 22, 12, 0, tzinfo=CST)
    for g in guides:
        pid = g["person_id"]
        base = g["rating"]
        trend_dir = rng.choices([-1, 0, 1], weights=[2, 5, 3])[0]
        for k in range(g["rating_count"]):
            age_days = rng.randint(0, 180)
            ts = now - timedelta(days=age_days, minutes=rng.randint(0, 600))
            if age_days <= 30:
                adj = 0.12 * trend_dir
            else:
                adj = -0.06 * trend_dir
            rating = _round3(min(5.0, max(1.0, base + adj + rng.uniform(-0.4, 0.4))))
            def dim():
                return _round3(min(5.0, max(1.0, base + rng.uniform(-0.5, 0.5))))
            rows.append({
                "review_id": f"RV{rng.randint(10000, 99999)}",
                "person_id": pid,
                "visitor_id": f"V{rng.randint(1, 60):04d}",
                "rating": rating,
                "dim_accuracy": dim(),
                "dim_expression": dim(),
                "dim_attitude": dim(),
                "dim_punctuality": dim(),
                "review_text": rng.choice(REVIEW_TEXT_POOL),
                "ts": ts.isoformat(),
            })
    return rows


def make_events(guides, rng):
    """生成游客行为。book_guide 必须引用真实可预约时段，并配 book_confirmed。"""
    rows = []
    visitor_langs = {}
    visitor_tags = {}
    visitors = [f"V{i:04d}" for i in range(1, 61)]
    for v in visitors:
        visitor_langs[v] = rng.choices(["普通话", "普通话", "普通话", "粤语", "English"])[0]
        visitor_tags[v] = rng.sample(
            ["历史", "建筑", "美食", "非遗", "侨乡", "摄影", "亲子"], k=rng.randint(1, 3))
    start = datetime(2026, 10, 28, 8, 0, tzinfo=CST)
    end = datetime(2026, 11, 22, 20, 0, tzinfo=CST)

    def rand_ts(lo, hi):
        span = (hi - lo).total_seconds()
        return lo + timedelta(seconds=rng.randint(0, int(span)))

    # 预计算每个游客可预约的讲解员（语种匹配 + 有可预约时段）
    def eligible_guides(v):
        lang = visitor_langs[v]
        return [g for g in guides if lang in g["languages"] and g["available_slots"]]

    for v in visitors:
        pts = rng.sample(POINTS, k=rng.randint(2, 4))
        t = rand_ts(start, end)
        for p in pts:
            pid = p[0]
            # 到达点位
            t += timedelta(minutes=rng.randint(5, 30))
            rows.append(dict(visitor_id=v, ts=t.isoformat(), event_type="arrive_point",
                             point_id=pid, route_id="", dwell_seconds=rng.randint(120, 900),
                             interest_tags="|".join(p[5]), device_lang=visitor_langs[v], guide_id=""))
            # 听讲解
            t += timedelta(minutes=rng.randint(2, 10))
            rows.append(dict(visitor_id=v, ts=t.isoformat(), event_type="listen_guide",
                             point_id=pid, route_id="", dwell_seconds=rng.randint(180, 1200),
                             interest_tags="|".join(p[5]), device_lang=visitor_langs[v], guide_id=""))
            # 偶发提问
            if rng.random() < 0.4:
                rows.append(dict(visitor_id=v, ts=t.isoformat(), event_type="ask_question",
                                 point_id=pid, route_id="", dwell_seconds=60,
                                 interest_tags="|".join(p[5]), device_lang=visitor_langs[v], guide_id=""))
        # 路线浏览/采纳/走完
        route_id = f"R{rng.randint(1, 3):04d}"
        rows.append(dict(visitor_id=v, ts=t.isoformat(), event_type="view_route",
                         point_id="", route_id=route_id, dwell_seconds=rng.randint(10, 60),
                         interest_tags="|".join(visitor_tags[v]), device_lang=visitor_langs[v], guide_id=""))
        if rng.random() < 0.6:
            rows.append(dict(visitor_id=v, ts=t.isoformat(), event_type="adopt_route",
                             point_id="", route_id=route_id, dwell_seconds=0,
                             interest_tags="|".join(visitor_tags[v]), device_lang=visitor_langs[v], guide_id=""))
            if rng.random() < 0.7:
                rows.append(dict(visitor_id=v, ts=t.isoformat(), event_type="finish_route",
                                 point_id="", route_id=route_id, dwell_seconds=0,
                                 interest_tags="|".join(visitor_tags[v]), device_lang=visitor_langs[v], guide_id=""))
        # 停车浏览
        if rng.random() < 0.5:
            rows.append(dict(visitor_id=v, ts=t.isoformat(), event_type="view_parking",
                             point_id="LD009", route_id="", dwell_seconds=30,
                             interest_tags="", device_lang=visitor_langs[v], guide_id=""))
        # 预约人工讲解（约 40% 游客）
        elig = eligible_guides(v)
        if elig and rng.random() < 0.4:
            g = rng.choice(elig)
            d = rng.choice(sorted(g["available_slots"].keys()))
            slot = rng.choice(g["available_slots"][d])
            book_ts = datetime.fromisoformat(_slot_ts(d, slot))
            target_point = g["service_point_ids"][0]
            rows.append(dict(visitor_id=v, ts=book_ts.isoformat(), event_type="book_guide",
                             point_id=target_point, route_id="", dwell_seconds=0,
                             interest_tags="|".join(visitor_tags[v]), device_lang=visitor_langs[v],
                             guide_id=g["person_id"]))
            # 确认（合成：5~45 分钟）
            confirm_ts = book_ts + timedelta(minutes=rng.randint(5, 45))
            rows.append(dict(visitor_id=v, ts=confirm_ts.isoformat(), event_type="book_confirmed",
                             point_id=target_point, route_id="", dwell_seconds=0,
                             interest_tags="", device_lang=visitor_langs[v], guide_id=g["person_id"]))
        # 反馈
        if rng.random() < 0.2:
            rows.append(dict(visitor_id=v, ts=t.isoformat(), event_type="feedback",
                             point_id=pts[0][0], route_id="", dwell_seconds=0,
                             interest_tags="|".join(visitor_tags[v]), device_lang=visitor_langs[v], guide_id=""))

    rows.sort(key=lambda r: r["ts"])
    return rows


def main():
    rng = random.Random(SEED)
    points = make_points()
    guides = make_guides(rng)
    reviews = make_reviews(guides, rng)
    events = make_events(guides, rng)

    (HERE / "points.json").write_text(
        json.dumps(points, ensure_ascii=False, indent=2), encoding="utf-8")
    (HERE / "guides.json").write_text(
        json.dumps(guides, ensure_ascii=False, indent=2), encoding="utf-8")

    r_fields = ["review_id", "person_id", "visitor_id", "rating",
                "dim_accuracy", "dim_expression", "dim_attitude", "dim_punctuality",
                "review_text", "ts"]
    with open(HERE / "reviews.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=r_fields)
        w.writeheader()
        w.writerows(reviews)

    e_fields = ["visitor_id", "ts", "event_type", "point_id", "route_id",
                "dwell_seconds", "interest_tags", "device_lang", "guide_id"]
    with open(HERE / "visitor_events.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=e_fields)
        w.writeheader()
        w.writerows(events)

    print(f"points={len(points)} guides={len(guides)} reviews={len(reviews)} events={len(events)}")
    print(f"book_guide={sum(1 for e in events if e['event_type'] == 'book_guide')} "
          f"book_confirmed={sum(1 for e in events if e['event_type'] == 'book_confirmed')}")


if __name__ == "__main__":
    main()
