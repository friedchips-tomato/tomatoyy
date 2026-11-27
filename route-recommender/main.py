"""Entry point: run one complete example and (re)compute offline metrics.

Usage:
    python main.py            # print 3 candidate routes + metrics, refresh metrics.json

The demo prints three comparable candidate routes (culture / distance / depth),
each with its ordered stop list, straight-line and estimated walking distance,
visit and total time, recommendation reasons and generation latency. It also
runs the offline proxy evaluation and writes metrics.json next to this file.
"""

import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from io_utils import read_json, read_visitor_events, write_json  # noqa: E402
from recommender import RouteRecommender  # noqa: E402

DATA = Path(__file__).parent / "data"


def load_recommender():
    points = read_json(DATA / "points.json")
    lots = read_json(DATA / "parking_lots.json")
    profile = read_json(DATA / "visitor_profile.json")
    kg = read_json(DATA / "kg_relations.json")
    events = read_visitor_events(DATA / "visitor_events.csv")
    recommender = RouteRecommender(points, lots, [profile], events, kg)
    return recommender, points


def print_route(route, names, index):
    stop_names = " → ".join(names[key] for key in route["point_ids"])
    print(f"[{index}] {route['route_id']} · 侧重点：{route['side_focus']}")
    print(f"    访问顺序：{stop_names}")
    print(f"    直线距离 {route['straight_distance_meters']:.0f} 米，"
          f"估算步行 {route['distance_meters']:.0f} 米（约 {route['walk_minutes']:.1f} 分钟）")
    print(f"    游览 {route['visit_minutes']:.1f} 分钟，"
          f"总时长 {route['total_minutes']:.1f} 分钟 · 评分 {route['score']:.3f}")
    if route.get("parking_id"):
        print(f"    自驾：起点/返程停车场 {route['parking_id']}")
    if route.get("endpoint"):
        print(f"    终点：{route['endpoint']['name']}（{route['endpoint']['type']}）")
    for reason in route["reasons"]:
        print(f"    理由：{reason}")
    print()


def main():
    recommender, points = load_recommender()
    names = {point["point_id"]: point["name"] for point in points}
    points_by_id = {point["point_id"]: point for point in points}

    print("=" * 72)
    print("乐游蓬江 · 个性化路线推荐算法 · 演示")
    print("=" * 72)

    walk_request = {
        "visitor_id": "V0001",
        "origin": {"longitude": 113.0890, "latitude": 22.5840},
        "start_time": "2026-11-22T09:00:00+08:00",
        "duration_minutes": 60,
        "interest_tags": ["历史", "美食"],
        "pace": "normal",
        "transport": "walk",
        "parking_id": None,
        "must_include_point_ids": [],
        "excluded_point_ids": [],
        "max_walk_minutes": None,
    }
    print("\n【示例 1】步行 60 分钟，兴趣：历史、美食")
    walk = recommender.generate(walk_request)
    print(f"生成耗时 {walk['generated_ms']:.1f} ms · 状态 {walk['status']}")
    for i, route in enumerate(walk["routes"], 1):
        print_route(route, names, i)

    car_request = {
        **walk_request,
        "duration_minutes": 120,
        "transport": "car",
        "start_time": "2026-11-22T10:00:00+08:00",
    }
    print("【示例 2】自驾 120 分钟，停车场作为起点并兼顾停车与返程")
    car = recommender.generate(car_request)
    print(f"生成耗时 {car['generated_ms']:.1f} ms · 状态 {car['status']} · "
          f"选定停车场 {car.get('parking_id')}")
    if car.get("off_peak_advice"):
        advice = car["off_peak_advice"]
        print(f"错峰建议：{advice['reason']}（建议 {advice['suggested_start_time']}）")
    for i, route in enumerate(car["routes"], 1):
        print_route(route, names, i)

    # --- metrics ---
    print("=" * 72)
    print("离线指标（重新计算并写入 metrics.json）")
    print("=" * 72)
    from metrics import run_all, build_eval_requests, write_metrics

    walk_requests = build_eval_requests(160, seed=42, transport="walk")
    car_requests = build_eval_requests(40, seed=7, transport="car")
    metrics = run_all(recommender, points_by_id, walk_requests, car_requests, walk_request)
    write_json(Path(__file__).parent / "metrics.json", metrics)

    lat = metrics["latency_ms"]
    print(f"生成耗时（50 次）：p50={lat['p50_ms']} ms, p95={lat['p95_ms']} ms, "
          f"max={lat['max_ms']} ms（目标 ≤ {lat['target_ms']} ms）")
    adopt = metrics["adoption_proxy"]
    print(f"采纳率代理（n={adopt['n_visitors']}）：本算法 {adopt['adoption_rate_ours']:.1%}，"
          f"基线最近邻 {adopt['adoption_rate_baseline']:.1%}")
    dist = metrics["route_length_distribution"]
    print(f"路线长度分布（{dist['n_routes']} 条路线）："
          f"打卡点均值 {dist['point_count']['mean']}，"
          f"步行距离均值 {dist['walk_distance_meters']['mean']:.0f} 米")
    print(f"已写入 metrics.json")


if __name__ == "__main__":
    main()
