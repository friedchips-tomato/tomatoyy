# -*- coding: utf-8 -*-
"""讲解员服务能力画像测试：评价聚合、置信度、综合分、时段供给、复约率。"""
import pandas as pd
import pytest

import profile as profile_mod


def _reviews_df(rows):
    return pd.DataFrame(rows)


def test_aggregate_reviews_basic():
    df = _reviews_df([
        {"review_id": "R1", "person_id": "PV001", "visitor_id": "V0001",
         "rating": 4.0, "dim_accuracy": 4, "dim_expression": 4,
         "dim_attitude": 4, "dim_punctuality": 4, "review_text": "好", "ts": "2026-11-01T10:00:00+08:00"},
        {"review_id": "R2", "person_id": "PV001", "visitor_id": "V0002",
         "rating": 5.0, "dim_accuracy": 5, "dim_expression": 5,
         "dim_attitude": 5, "dim_punctuality": 5, "review_text": "很好", "ts": "2026-11-02T10:00:00+08:00"},
    ])
    stats = profile_mod.aggregate_reviews(df, "PV001")
    assert stats["rating_count"] == 2
    assert stats["avg_rating"] == 4.5
    assert stats["dim_means"]["accuracy"] == 4.5


def test_confidence_flag_sample_insufficient():
    rows = [{"review_id": f"R{i}", "person_id": "PV001", "visitor_id": f"V{i:04d}",
             "rating": 4.5, "dim_accuracy": 4, "dim_expression": 4,
             "dim_attitude": 4, "dim_punctuality": 4, "review_text": "好",
             "ts": "2026-11-10T10:00:00+08:00"} for i in range(1, 6)]
    stats = profile_mod.aggregate_reviews(_reviews_df(rows), "PV001")
    assert stats["sample_sufficient"] is False
    assert stats["confidence"] < 1.0


def test_capability_score_range():
    stats = {"person_id": "PV001", "rating_count": 50, "avg_rating": 4.8,
             "dim_means": {"accuracy": 4.8, "expression": 4.8, "attitude": 4.8, "punctuality": 4.8},
             "confidence": 1.0, "sample_sufficient": True}
    cap = profile_mod.capability_score(stats, repeat_rate=0.5)
    assert 0.0 <= cap["score"] <= 1.0
    assert set(cap["components"]) == {"rating", "dims", "punctuality", "repeat"}


def test_compute_repeat_rates():
    events = pd.DataFrame([
        {"visitor_id": "V0001", "ts": "2026-11-01T10:00:00+08:00", "event_type": "book_guide",
         "point_id": "", "route_id": "", "dwell_seconds": 0, "interest_tags": "",
         "device_lang": "普通话", "guide_id": "PV001"},
        {"visitor_id": "V0001", "ts": "2026-11-02T10:00:00+08:00", "event_type": "book_guide",
         "point_id": "", "route_id": "", "dwell_seconds": 0, "interest_tags": "",
         "device_lang": "普通话", "guide_id": "PV001"},
        {"visitor_id": "V0002", "ts": "2026-11-03T10:00:00+08:00", "event_type": "book_guide",
         "point_id": "", "route_id": "", "dwell_seconds": 0, "interest_tags": "",
         "device_lang": "普通话", "guide_id": "PV001"},
    ])
    rates = profile_mod.compute_repeat_rates(events)
    assert rates["PV001"] == pytest.approx(1 / 3)


def test_slot_supply_profile(guides):
    supply = profile_mod.slot_supply_profile(guides)
    assert "tight_slots" in supply
    assert len(supply["per_guide"]) == len(guides)
    # 紧张时段内的讲解员数量不得超过阈值
    import config
    for t in supply["tight_slots"]:
        assert t["guide_count"] <= config.SUPPLY_TIGHT_THRESHOLD
