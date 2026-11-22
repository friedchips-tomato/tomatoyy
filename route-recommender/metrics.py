"""Offline evaluation harness for the route recommender.

Everything here is a *proxy*: there is no live traffic data, so adoption is
estimated on a synthetic, reproducible evaluation set with a fixed random seed.
The same evaluation set and the same utility function are applied to both the
recommender and the pure nearest-neighbour baseline, so the comparison is fair.
"""

import json
import random
import statistics
from datetime import datetime, timedelta
from pathlib import Path

from io_utils import BEIJING, INTEREST_TAGS, timestamp
from recommender import VERSION, RouteRecommender

PACKAGE_DIR = Path(__file__).resolve().parent
DATA_DIR = PACKAGE_DIR / "data"

# --- synthetic evaluation set -------------------------------------------------

# District bounding box derived from data/points.json (Jiangmen Changdi area).
# Origins are jittered inside this box so every visitor starts near the district.
DISTRICT_BBOX = {"lon_min": 113.081, "lon_max": 113.092, "lat_min": 22.580, "lat_max": 22.590}

# Common interest tags are sampled more often so the set is representative of a
# heritage district audience rather than uniform noise.
_INTEREST_POOL = ("历史", "建筑", "美食", "侨乡", "摄影", "非遗", "自然", "亲子")
_INTEREST_WEIGHTS = (0.26, 0.20, 0.16, 0.14, 0.10, 0.06, 0.05, 0.03)

_PACES = ("relaxed", "normal", "deep")
_DURATIONS = (30, 60, 120)


def build_eval_requests(n, seed=42, transport="walk", start_date="2026-11-22"):
    """Deterministic synthetic visitors. Returns valid route_request dicts."""
    rng = random.Random(seed)
    requests = []
    for _ in range(n):
        k = rng.randint(1, 3)
        # Weighted sampling for realistic tag coverage (popular tags more likely).
        interests = tuple(rng.choices(_INTEREST_POOL, weights=_INTEREST_WEIGHTS, k=k))
        interests = tuple(dict.fromkeys(interests))  # dedupe, keep order
        hour = rng.randint(9, 17)
        minute = rng.choice((0, 15, 30, 45))
        start = datetime(2026, 11, 22, hour, minute, tzinfo=BEIJING)
        requests.append({
            "visitor_id": f"V{9000 + _:04d}",
            "origin": {
                "longitude": round(rng.uniform(DISTRICT_BBOX["lon_min"], DISTRICT_BBOX["lon_max"]), 6),
                "latitude": round(rng.uniform(DISTRICT_BBOX["lat_min"], DISTRICT_BBOX["lat_max"]), 6),
            },
            "start_time": start.isoformat(timespec="seconds"),
            "duration_minutes": rng.choice(_DURATIONS),
            "interest_tags": list(interests),
            "pace": rng.choice(_PACES),
            "transport": transport,
            "parking_id": None,
            "must_include_point_ids": [],
            "excluded_point_ids": [],
            "max_walk_minutes": None,
        })
    return requests


# --- adoption proxy ------------------------------------------------------------

# A visitor "adopts" the shown set of up-to-3 candidate routes when at least one
# route contains >= MIN_MATCHED_STOPS stops matching one of their declared
# interest tags. This is an interpretable proxy for "I found a route I actually
# want to follow", and it is applied identically to the recommender and to the
# pure nearest-neighbour baseline. (Walk is already bounded by the time budget
# in both, so it is not a differentiator here.)
MIN_MATCHED_STOPS = 2


def matched_stops(route, interests, points):
    return sum(
        1 for key in route["point_ids"]
        if set(points[key]["interest_tags"]) & interests
    )


def adopts(routes, interests, points):
    return any(matched_stops(route, interests, points) >= MIN_MATCHED_STOPS for route in routes)


def adoption_proxy(recommender, requests, points):
    """Compute the adoption rate for the recommender and the distance baseline."""
    ours = baseline = 0
    shown = 0
    ours_mean_match = baseline_mean_match = 0.0
    for request in requests:
        interests = set(request["interest_tags"])
        result = recommender.generate(request)
        base = recommender.generate(request, baseline=True)
        if result["routes"] or base["routes"]:
            shown += 1
            ours += int(adopts(result["routes"], interests, points))
            baseline += int(adopts(base["routes"], interests, points))
            ours_mean_match += max(
                (matched_stops(route, interests, points) for route in result["routes"]),
                default=0,
            )
            baseline_mean_match += max(
                (matched_stops(route, interests, points) for route in base["routes"]),
                default=0,
            )
    return {
        "n_visitors": shown,
        "adoption_rate_ours": round(ours / shown, 4) if shown else None,
        "adoption_rate_baseline": round(baseline / shown, 4) if shown else None,
        "baseline": "纯距离最近邻排序（同一可行性校验与时间窗约束）",
        "criterion": (
            f"任意一条候选路线含 >= {MIN_MATCHED_STOPS} 个命中兴趣标签的点位即视为采纳"
        ),
        "mean_best_matched_stops_ours": round(ours_mean_match / shown, 3) if shown else None,
        "mean_best_matched_stops_baseline": round(baseline_mean_match / shown, 3) if shown else None,
        "note": "合成评测集、固定随机种子 42，仅 walk 出行；非真实埋点采纳率",
    }


# --- latency benchmark ---------------------------------------------------------

def latency_benchmark(recommender, request, runs=50):
    samples = [recommender.generate(request)["generated_ms"] for _ in range(runs)]
    samples.sort()
    return {
        "runs": runs,
        "p50_ms": round(statistics.median(samples), 3),
        "p95_ms": round(samples[int(len(samples) * 0.95) - 1], 3),
        "mean_ms": round(statistics.mean(samples), 3),
        "max_ms": round(max(samples), 3),
        "target_ms": 3000,
    }


# --- route length distribution --------------------------------------------------

def length_distribution(recommender, requests):
    """Distribution of point counts and walk distances over every produced route."""
    counts = []
    walk_m = []
    for request in requests:
        for route in recommender.generate(request)["routes"]:
            counts.append(len(route["point_ids"]))
            walk_m.append(route["distance_meters"])
    buckets = {}
    for lo, hi in ((1, 2), (3, 4), (5, 6), (7, 8), (9, 12), (13, 99)):
        buckets[f"{lo}-{hi}"] = sum(1 for c in counts if lo <= c <= hi)
    return {
        "n_routes": len(counts),
        "point_count": {
            "mean": round(statistics.mean(counts), 3),
            "median": statistics.median(counts),
            "buckets": buckets,
        },
        "walk_distance_meters": {
            "mean": round(statistics.mean(walk_m), 3),
            "median": round(statistics.median(walk_m), 3),
            "max": round(max(walk_m), 3) if walk_m else None,
        },
    }


# --- parking / off-peak advice proxy --------------------------------------------

def parking_advice_proxy(recommender, car_requests):
    """Proxy for the off-peak advice *coverage* (adoption needs real event data).

    真实采纳率口径（见 README）：以埋点 `adopt_parking` 为准，即「按建议时间
    到达（实际 ts 与 suggested_start_time 偏差 <= 30 分钟）的自驾请求数 /
    收到错峰建议的自驾请求数」。本包没有真实预测余位与埋点，因此这里只报
    代理口径一：在高峰时段发起的自驾请求中，算法给出错峰建议的覆盖率。
    """
    peak_requests = advised = 0
    for request in car_requests:
        result = recommender.generate(request)
        started = timestamp(request["start_time"])
        if not is_peak_hour(started):
            continue
        peak_requests += 1
        if result.get("off_peak_advice"):
            advised += 1
    return {
        "n_car_requests_peak_time": peak_requests,
        "n_with_off_peak_advice": advised,
        "off_peak_advice_coverage_proxy": round(advised / peak_requests, 4) if peak_requests else None,
        "real_adoption_metric": (
            "按建议时间到达的自驾请求数 / 收到错峰建议的自驾请求数，"
            "以埋点 adopt_parking 的 ts 与 suggested_start_time 偏差 <= 30 分钟计"
        ),
        "note": "本包无真实预测余位与埋点，仅报建议覆盖率；真实采纳率口径见 README",
    }


def is_peak_hour(at_time):
    # Mirrors parking.is_peak: weekend 10-12 / 14-17, weekday 11-13 / 17-19.
    hour = at_time.hour
    peaks = ((10, 12), (14, 17)) if at_time.weekday() >= 5 else ((11, 13), (17, 19))
    return any(begin <= hour < end for begin, end in peaks)


# --- entry point ----------------------------------------------------------------

def run_all(recommender, points, walk_requests, car_requests, latency_request):
    return {
        "algo_version": VERSION,
        "generated_at": datetime.now(BEIJING).isoformat(timespec="seconds"),
        "latency_ms": latency_benchmark(recommender, latency_request, runs=50),
        "adoption_proxy": adoption_proxy(recommender, walk_requests, points),
        "route_length_distribution": length_distribution(recommender, walk_requests),
        "parking_advice_proxy": parking_advice_proxy(recommender, car_requests),
    }


def load_defaults():
    """Load the package data files and build a default recommender + eval set."""
    from io_utils import read_json, read_visitor_events

    points = read_json(DATA_DIR / "points.json")
    lots = read_json(DATA_DIR / "parking_lots.json")
    profile = read_json(DATA_DIR / "visitor_profile.json")
    kg = read_json(DATA_DIR / "kg_relations.json")
    events = read_visitor_events(DATA_DIR / "visitor_events.csv")

    recommender = RouteRecommender(points, lots, [profile], events, kg)
    points_by_id = {point["point_id"]: point for point in points}
    return recommender, points_by_id, lots, profile


def write_metrics(path=None, n_walk=160, n_car=40):
    if path is None:
        path = PACKAGE_DIR / "metrics.json"
    recommender, points, lots, profile = load_defaults()
    walk_requests = build_eval_requests(n_walk, seed=42, transport="walk")
    car_requests = build_eval_requests(n_car, seed=7, transport="car")
    # A representative latency request: the demo walk request used in main.py.
    latency_request = {
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
    result = run_all(recommender, points, walk_requests, car_requests, latency_request)
    with open(path, "w", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
    return result


if __name__ == "__main__":
    result = write_metrics()
    print(json.dumps(result, ensure_ascii=False, indent=2))
