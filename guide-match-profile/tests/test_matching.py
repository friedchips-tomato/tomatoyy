# -*- coding: utf-8 -*-
"""匹配模块测试：语种硬过滤、时段冲突、评分排序、可用时段、改约候选。"""
import matching


def _guide(pid, *, rating=4.6, languages=("普通话", "粤语"), radius=1000,
           price=200, point_ids=("LD006",), slots=("10:30",), loc=(22.575, 113.090)):
    return {
        "person_id": pid, "name": f"讲解员{pid}", "languages": list(languages),
        "rating": rating, "rating_count": 50,
        "service_point_ids": list(point_ids), "service_radius_m": radius,
        "location": {"longitude": loc[1], "latitude": loc[0], "coord_system": "WGS84"},
        "service_hours": {"mon_fri": ["09:00-18:00"], "sat_sun": ["09:00-18:00"]},
        "price": price, "bio": "", "capacity_per_slot": 1,
        "available_slots": {"2026-11-22": list(slots)},
    }


def _point():
    return {
        "point_id": "LD006", "name": "堤东路骑楼（示例）",
        "latitude": 22.575, "longitude": 113.090,
    }


def _query(**kw):
    base = {
        "visitor_id": "V0001", "device_lang": "普通话",
        "requested_languages": ["普通话"], "target_point_id": "LD006",
        "date": "2026-11-22", "time": "10:30",
    }
    base.update(kw)
    return base


def _ctx(guides, bookings=None):
    return {
        "guides": guides,
        "points_by_id": {"LD006": _point()},
        "guide_by_id": {g["person_id"]: g for g in guides},
        "stats": {g["person_id"]: None for g in guides},
        "bookings": bookings or {},
    }


# 1) 语种硬过滤
def test_language_hard_filter():
    g_zh = _guide("PV_A", languages=("普通话", "粤语"))
    g_en = _guide("PV_B", languages=("English", "粤语"))
    q = _query(device_lang="普通话", requested_languages=["普通话"])
    assert matching.language_filter(g_zh, q)[0] is True
    assert matching.language_filter(g_en, q)[0] is False

    eligible, rejected = matching.eligible_guides(q, _ctx([g_zh, g_en]))
    assert [g["person_id"] for g in eligible] == ["PV_A"]
    assert any("语种" in r["reason"] for r in rejected)


def test_language_filter_requires_all_requested():
    g = _guide("PV_A", languages=("普通话", "粤语"))
    q = _query(device_lang="普通话", requested_languages=["普通话", "English"])
    assert matching.language_filter(g, q)[0] is False


# 2) 时段冲突检测
def test_slot_conflict_detection():
    g = _guide("PV_A", slots=("10:30",))
    q = _query()
    # 无预约：通过
    ok, reason = matching.slot_filter(g, q["date"], q["time"], {})
    assert ok and reason is None
    # 已被预约（capacity 1）：冲突
    ok, reason = matching.slot_filter(g, q["date"], q["time"],
                                      {(g["person_id"], q["date"], q["time"]): 1})
    assert ok is False and "仅一单" in reason


def test_build_bookings_counts_conflict():
    import pandas as pd
    events = pd.DataFrame([
        {"visitor_id": "V0001", "ts": "2026-11-22T10:30:00+08:00",
         "event_type": "book_guide", "point_id": "LD006", "route_id": "",
         "dwell_seconds": 0, "interest_tags": "", "device_lang": "普通话",
         "guide_id": "PV_A"},
    ])
    bookings = matching.build_bookings(events)
    assert bookings[("PV_A", "2026-11-22", "10:30")] == 1


def test_available_slots_query_marks_conflict():
    g = _guide("PV_A", slots=("10:30",))
    ctx = _ctx([g], bookings={(g["person_id"], "2026-11-22", "10:30"): 1})
    rows = matching.query_available_slots("2026-11-22", "10:30", ctx,
                                          requested_languages=["普通话"],
                                          device_lang="普通话")
    assert rows[0]["conflict"] is True
    assert rows[0]["remaining"] == 0


# 3) 评分排序
def test_scoring_prefers_higher_rating():
    lo = _guide("PV_LO", rating=4.0)
    hi = _guide("PV_HI", rating=4.9)
    ctx = _ctx([lo, hi])
    top, scored, _ = matching.match(_query(), ctx, top_n=2)
    assert scored[0]["person_id"] == "PV_HI"
    assert scored[0]["score"] > scored[1]["score"]


def test_match_returns_reasons_and_language_flag():
    g = _guide("PV_A", rating=4.8)
    top, scored, _ = matching.match(_query(), _ctx([g]), top_n=1)
    rec = top[0]
    assert 1 <= len(rec["reasons"]) <= 3
    assert all(isinstance(r, str) for r in rec["reasons"])
    assert rec["language_match"] is True
    assert rec["distance_m"] >= 0


# 4) 改约候选
def test_reschedule_candidates_sorted_and_exclude_conflict():
    g = _guide("PV_A", slots=("10:30", "11:00", "12:00"))
    ctx = _ctx([g], bookings={(g["person_id"], "2026-11-22", "11:00"): 1})
    cands = matching.reschedule_candidates(g["person_id"], "2026-11-22", "10:30", ctx)
    offsets = [c["offset_minutes"] for c in cands]
    assert offsets == sorted(offsets)
    # 被占用的 11:00 不应出现在候选里
    assert all(not (c["date"] == "2026-11-22" and c["time"] == "11:00") for c in cands)


# 集成：完整示例数据跑一次匹配，验证硬过滤后无越界推荐
def test_integration_match_no_language_leak(ctx):
    q = {
        "visitor_id": "V0001", "device_lang": "普通话",
        "requested_languages": ["普通话"], "target_point_id": "LD006",
        "date": "2026-11-22", "time": "10:30",
    }
    top, scored, rejected = matching.match(q, ctx, top_n=3)
    assert len(top) >= 1
    for s in scored:
        g = ctx["guide_by_id"][s["person_id"]]
        assert "普通话" in g["languages"]
    # 无普通话的讲解员必须被拒
    rejected_ids = {r["person_id"] for r in rejected}
    for g in ctx["guides"]:
        if "普通话" not in g["languages"]:
            assert g["person_id"] in rejected_ids
