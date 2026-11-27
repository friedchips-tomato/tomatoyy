"""Car-mode parking linkage and replan / progress tests."""

import pytest

from conftest import make_request


def test_car_mode_uses_parking_as_origin(recommender):
    request = make_request(transport="car", duration_minutes=120)
    result = recommender.generate(request)
    assert result["status"] == "ok"
    assert result["parking_id"] in recommender.lots
    for route in result["routes"]:
        assert route["parking_id"] == result["parking_id"]
        assert route["endpoint"]["type"] == "return_to_parking"


def test_car_mode_ranks_parking_options(recommender):
    request = make_request(transport="car", duration_minutes=120)
    result = recommender.generate(request)
    options = result.get("parking_options", [])
    assert len(options) == len(recommender.lots)
    # Ranking must prefer selectable lots and be deterministic.
    scores = [option["score"] for option in options]
    assert scores == sorted(scores, reverse=True)


def test_explicit_parking_id_respected(recommender):
    request = make_request(transport="car", duration_minutes=120, parking_id="PK001")
    result = recommender.generate(request)
    assert result["parking_id"] == "PK001"


def test_walk_mode_rejects_parking_id(recommender):
    with pytest.raises(ValueError):
        recommender.generate(make_request(transport="walk", parking_id="PK001"))


def test_save_progress_and_replan(recommender, walk_request):
    result = recommender.generate(walk_request)
    route = result["routes"][0]
    first_two = route["point_ids"][:2]
    progress = recommender.save_progress(
        walk_request,
        route,
        completed_point_ids=first_two,
        elapsed_minutes=30,
        walk_minutes_used=12,
        saved_at="2026-11-22T09:30:00+08:00",
    )
    assert progress["remaining_point_ids"] == route["point_ids"][2:]
    assert progress["completed_point_ids"] == first_two

    replanned = recommender.replan(
        current_point_id=first_two[-1],
        current_location=None,
        progress=progress,
        now="2026-11-22T09:30:00+08:00",
    )
    assert replanned["status"] in ("ok", "limited_alternatives", "completed")
    for route in replanned["routes"]:
        assert route["total_minutes"] <= 30 + 1e-6  # remaining budget
        for pid in first_two:
            assert pid not in route["point_ids"]


def test_save_progress_validations(recommender, walk_request):
    result = recommender.generate(walk_request)
    route = result["routes"][0]
    with pytest.raises(ValueError):
        recommender.save_progress(
            walk_request, route, completed_point_ids=[],
            elapsed_minutes=5, walk_minutes_used=10,  # walk > elapsed
            saved_at="2026-11-22T09:30:00+08:00",
        )
    with pytest.raises(ValueError):
        recommender.save_progress(
            walk_request, route, completed_point_ids=["LD999"],
            elapsed_minutes=10, walk_minutes_used=5,
            saved_at="2026-11-22T09:30:00+08:00",
        )
