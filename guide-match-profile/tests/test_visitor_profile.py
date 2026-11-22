# -*- coding: utf-8 -*-
"""游客兴趣画像测试：增量单调性、画像字段、脱敏检查。"""
import pandas as pd

import visitor_profile as vp


def _points():
    return {
        "LD002": {"point_id": "LD002", "name": "启明里（示例）",
                  "interest_tags": ["历史", "建筑", "侨乡"]},
        "LD012": {"point_id": "LD012", "name": "侨乡咖啡老店（示例）",
                  "interest_tags": ["美食", "侨乡"]},
    }


def _guides():
    return {"PV001": {"person_id": "PV001", "price": 200}}


def _event(**kw):
    base = {
        "visitor_id": "V0001", "ts": "2026-11-22T10:00:00+08:00",
        "event_type": "arrive_point", "point_id": "LD002", "route_id": "",
        "dwell_seconds": 120, "interest_tags": "历史|建筑", "device_lang": "普通话",
        "guide_id": "",
    }
    base.update(kw)
    return base


def test_incremental_monotonicity():
    p = vp.empty_profile("V0001", now="2026-11-22T12:00:00+08:00")
    points = _points()
    for _ in range(3):
        vp.update_profile(p, _event(ts="2026-11-22T10:00:00+08:00"), points, _guides(),
                          now="2026-11-22T12:00:00+08:00")
    # 同一标签权重只增不减，且非负
    assert p["interest_tags"]["历史"] > 0
    assert p["interest_tags"]["建筑"] > 0
    assert all(w >= 0 for w in p["interest_tags"].values())
    assert p["total_events"] == 3


def test_profile_fields_and_visited_points():
    points = _points()
    p = vp.empty_profile("V0001")
    vp.update_profile(p, _event(point_id="LD002"), points, _guides())
    vp.update_profile(p, _event(point_id="LD012"), points, _guides())
    out = vp.finalize_profile(p)
    for key in ["interest_tags", "active_hours", "languages", "price_preference",
                "visited_points", "total_events", "visitor_id"]:
        assert key in out
    assert out["visited_points"] == 2


def test_behavior_to_interest_mapping():
    points = _points()
    # arrive_point 用点位标签；view_route 用事件自带标签
    p = vp.empty_profile("V0001")
    vp.update_profile(p, _event(event_type="view_route", point_id="",
                                interest_tags="美食|摄影"), points, _guides())
    assert p["interest_tags"]["美食"] == vp.config.EVENT_WEIGHTS["view_route"]


def test_deidentify_ok():
    points = _points()
    p = vp.empty_profile("V0001")
    vp.update_profile(p, _event(), points, _guides())
    out = vp.finalize_profile(p)
    ok, problems = vp.deidentify_ok(out)
    assert ok, problems


def test_deidentify_detects_pii():
    bad = {"visitor_id": "V0001", "name": "张三", "phone": "13812345678",
           "interest_tags": {}}
    ok, problems = vp.deidentify_ok(bad)
    assert ok is False
    assert any("手机号" in x for x in problems)
    assert any("PII" in x for x in problems)
