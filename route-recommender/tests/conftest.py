"""Shared pytest fixtures for the route-recommender package.

Adds the package directory to sys.path so the top-level modules
(recommender / io_utils / scoring / parking / schedule / metrics) import
regardless of the working directory, and loads the contract data once per
session.
"""

import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parents[1]
if str(PACKAGE_DIR) not in sys.path:
    sys.path.insert(0, str(PACKAGE_DIR))

from io_utils import read_json, read_visitor_events  # noqa: E402
from recommender import RouteRecommender  # noqa: E402

DATA = PACKAGE_DIR / "data"


@pytest.fixture(scope="session")
def points():
    return read_json(DATA / "points.json")


@pytest.fixture(scope="session")
def points_by_id(points):
    return {point["point_id"]: point for point in points}


@pytest.fixture(scope="session")
def lots():
    return read_json(DATA / "parking_lots.json")


@pytest.fixture(scope="session")
def events():
    return read_visitor_events(DATA / "visitor_events.csv")


@pytest.fixture(scope="session")
def recommender(points, lots, events):
    profile = read_json(DATA / "visitor_profile.json")
    kg = read_json(DATA / "kg_relations.json")
    return RouteRecommender(points, lots, [profile], events, kg)


def make_request(**overrides):
    request = {
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
    request.update(overrides)
    return request


@pytest.fixture
def walk_request():
    return make_request()
