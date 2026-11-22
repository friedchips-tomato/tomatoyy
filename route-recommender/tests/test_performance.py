"""Performance benchmark and offline proxy metrics tests."""

from time import perf_counter

import pytest

from conftest import make_request
from metrics import (
    adoption_proxy,
    build_eval_requests,
    latency_benchmark,
    length_distribution,
    run_all,
)


def test_generation_within_3_seconds(recommender, walk_request):
    # Warm up the cache, then measure several fresh generations.
    recommender.generate(walk_request)
    worst = 0.0
    for _ in range(10):
        start = perf_counter()
        recommender.generate(walk_request)
        worst = max(worst, (perf_counter() - start) * 1000)
    assert worst < 3000, f"生成耗时 {worst:.1f} ms 超过 3000 ms 目标"


def test_latency_benchmark_reports_p50_p95(recommender, walk_request):
    result = latency_benchmark(recommender, walk_request, runs=20)
    assert result["runs"] == 20
    assert 0 <= result["p50_ms"] <= result["p95_ms"] <= result["max_ms"]
    assert result["p95_ms"] < 3000


def test_eval_requests_deterministic():
    first = build_eval_requests(10, seed=42)
    second = build_eval_requests(10, seed=42)
    assert first == second
    assert build_eval_requests(10, seed=1) != build_eval_requests(10, seed=2)


def test_adoption_proxy_beats_baseline(recommender, points_by_id):
    requests = build_eval_requests(60, seed=42, transport="walk")
    proxy = adoption_proxy(recommender, requests, points_by_id)
    assert proxy["n_visitors"] == 60
    assert 0 <= proxy["adoption_rate_ours"] <= 1
    assert 0 <= proxy["adoption_rate_baseline"] <= 1
    assert proxy["adoption_rate_ours"] > proxy["adoption_rate_baseline"]


def test_length_distribution_counts(recommender):
    requests = build_eval_requests(20, seed=42, transport="walk")
    distribution = length_distribution(recommender, requests)
    assert distribution["n_routes"] >= 1
    total_bucketed = sum(distribution["point_count"]["buckets"].values())
    assert total_bucketed == distribution["n_routes"]


def test_run_all_returns_required_keys(recommender, points_by_id, walk_request):
    walk = build_eval_requests(12, seed=42, transport="walk")
    car = build_eval_requests(6, seed=7, transport="car")
    metrics = run_all(recommender, points_by_id, walk, car, walk_request)
    for key in ("latency_ms", "adoption_proxy", "route_length_distribution", "parking_advice_proxy"):
        assert key in metrics, key
