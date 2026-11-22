"""Data contract tests: ID uniqueness, category/tag vocabulary, geometry."""

import re

from conftest import DATA, make_request
from io_utils import CATEGORIES, INTEREST_TAGS, read_visitor_events


def test_at_least_100_points(points):
    assert len(points) >= 100


def test_point_ids_unique_and_prefixed(points):
    ids = [p["point_id"] for p in points]
    assert len(ids) == len(set(ids)), "点位 ID 必须唯一"
    for pid in ids:
        assert re.fullmatch(r"LD[0-9]{3,}", pid), f"无效 point_id：{pid}"


def test_parking_ids_unique_and_prefixed(lots):
    ids = [lot["parking_id"] for lot in lots]
    assert len(ids) == len(set(ids)), "停车场 ID 必须唯一"
    for pid in ids:
        assert re.fullmatch(r"PK[0-9]{3,}", pid), f"无效 parking_id：{pid}"


def test_point_category_and_tags_within_vocabulary(points):
    for point in points:
        assert point["category"] in CATEGORIES, point["point_id"]
        assert set(point["interest_tags"]) <= INTEREST_TAGS, point["point_id"]
        assert point["coord_system"] == "WGS84"
        assert -180 <= point["longitude"] <= 180
        assert -90 <= point["latitude"] <= 90


def test_parking_fields_valid(lots):
    for lot in lots:
        assert lot["coord_system"] == "WGS84"
        assert isinstance(lot["total_spaces"], int) and lot["total_spaces"] > 0


def test_synthetic_data_marked(points):
    # Every point must carry a verified flag; placeholder data stays verified: false.
    assert all("verified" in point for point in points)
    # The real heritage anchors from the prototype remain unverified, per the
    # authenticity red line, so no assertion forces them to be true.
    assert all(isinstance(point["verified"], bool) for point in points)


def test_visitor_events_parse_and_valid():
    events = read_visitor_events(DATA / "visitor_events.csv")
    assert events, "visitor_events.csv 不能为空"
    for event in events:
        assert event["event_type"], event
        assert set(event["interest_tags"]) <= INTEREST_TAGS


def test_visitor_profile_shape():
    import json
    profile = json.loads((DATA / "visitor_profile.json").read_text(encoding="utf-8"))
    assert profile["visitor_id"].startswith("V")
    assert set(profile["interest_tags"]) <= INTEREST_TAGS
