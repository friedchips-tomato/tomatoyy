"""Behavioural tests for the three-candidate route generation."""

import pytest

from conftest import make_request


def test_three_routes_distinct(recommender, walk_request):
    result = recommender.generate(walk_request)
    assert result["status"] == "ok", result
    assert len(result["routes"]) == 3
    focuses = [route["side_focus"] for route in result["routes"]]
    assert set(focuses) == {"culture", "distance", "depth"}
    sets = [tuple(route["point_ids"]) for route in result["routes"]]
    assert len(set(sets)) == 3, "三条候选路线必须互不相同"


def test_time_budget_never_violated(recommender, points):
    # Scan several durations and paces: total time must stay within budget.
    for duration in (30, 60, 120):
        for pace in ("relaxed", "normal", "deep"):
            request = make_request(duration_minutes=duration, pace=pace)
            result = recommender.generate(request)
            for route in result["routes"]:
                assert route["total_minutes"] <= duration + 1e-6, (
                    duration, pace, route["total_minutes"]
                )


def test_closed_points_excluded(recommender, points):
    closed_monday = [p["point_id"] for p in points if "mon" in p["opening_hours"]["closed_days"]]
    assert closed_monday, "测试数据需要至少一个周一闭馆点位"
    request = make_request(start_time="2026-11-23T09:00:00+08:00")  # Monday
    result = recommender.generate(request)
    chosen = [pid for route in result["routes"] for pid in route["point_ids"]]
    assert not set(chosen) & set(closed_monday)


def test_must_include_points_present(recommender):
    request = make_request(must_include_point_ids=["LD002"])
    result = recommender.generate(request)
    assert result["status"] in ("ok", "limited_alternatives")
    for route in result["routes"]:
        assert "LD002" in route["point_ids"]


def test_must_include_closed_point_reported(recommender, points):
    closed = next(p["point_id"] for p in points if "mon" in p["opening_hours"]["closed_days"])
    request = make_request(
        start_time="2026-11-23T09:00:00+08:00", must_include_point_ids=[closed],
    )
    result = recommender.generate(request)
    assert result["status"] == "required_points_unavailable"


def test_excluded_points_absent(recommender):
    request = make_request(excluded_point_ids=["LD002", "LD003"])
    result = recommender.generate(request)
    chosen = [pid for route in result["routes"] for pid in route["point_ids"]]
    assert "LD002" not in chosen and "LD003" not in chosen


def test_conflicting_must_and_exclude(recommender):
    request = make_request(must_include_point_ids=["LD002"], excluded_point_ids=["LD002"])
    result = recommender.generate(request)
    assert result["status"] == "conflicting_points"


def test_reasons_present_and_bounded(recommender, walk_request):
    result = recommender.generate(walk_request)
    for route in result["routes"]:
        assert 2 <= len(route["reasons"]) <= 4
        assert all(isinstance(reason, str) and reason for reason in route["reasons"])


def test_distance_fields_consistent(recommender, walk_request):
    result = recommender.generate(walk_request)
    for route in result["routes"]:
        detour = recommender.settings.detour_factor
        assert route["distance_meters"] == pytest.approx(
            route["straight_distance_meters"] * detour, rel=1e-3
        )
        assert route["walk_minutes"] == pytest.approx(
            route["distance_meters"] / recommender.settings.walking_m_per_min, rel=1e-3
        )
        assert route["visit_minutes"] + route["walk_minutes"] == pytest.approx(
            route["total_minutes"], rel=1e-6
        )
        assert route["order"] == list(range(len(route["point_ids"])))


def test_route_id_prefixed_and_unique(recommender, walk_request):
    result = recommender.generate(walk_request)
    ids = [route["route_id"] for route in result["routes"]]
    assert len(ids) == len(set(ids))
    for route_id in ids:
        assert route_id.startswith("R") and route_id[1:].isdigit()


def test_invalid_request_rejected(recommender, walk_request):
    with pytest.raises(ValueError):
        recommender.generate(make_request(duration_minutes=45))
    with pytest.raises(ValueError):
        recommender.generate(make_request(interest_tags=["不存在的标签"]))
    with pytest.raises(ValueError):
        recommender.generate(make_request(must_include_point_ids=["LD999"]))
