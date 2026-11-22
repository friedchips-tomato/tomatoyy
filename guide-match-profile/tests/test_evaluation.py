# -*- coding: utf-8 -*-
"""代理评估与指标函数测试。"""
import pandas as pd
import pytest

import evaluation


def _events(rows):
    cols = ["visitor_id", "ts", "event_type", "point_id", "route_id",
            "dwell_seconds", "interest_tags", "device_lang", "guide_id"]
    return pd.DataFrame(rows, columns=cols)


def test_booking_usage_rate():
    ev = _events([
        ["V0001", "2026-11-22T09:00:00+08:00", "arrive_point", "LD001", "", 10, "历史", "普通话", ""],
        ["V0001", "2026-11-22T10:00:00+08:00", "book_guide", "LD001", "", 0, "", "普通话", "PV001"],
        ["V0002", "2026-11-22T09:00:00+08:00", "arrive_point", "LD001", "", 10, "历史", "普通话", ""],
        ["V0003", "2026-11-22T09:00:00+08:00", "arrive_point", "LD001", "", 10, "历史", "普通话", ""],
    ])
    m = evaluation.booking_usage_rate(ev)
    assert m["n_visitors"] == 3
    assert m["n_bookers"] == 1
    assert m["booking_usage_rate"] == pytest.approx(1 / 3, abs=1e-3)


def test_avg_confirmation_minutes():
    ev = _events([
        ["V0001", "2026-11-22T10:00:00+08:00", "book_guide", "LD001", "", 0, "", "普通话", "PV001"],
        ["V0001", "2026-11-22T10:30:00+08:00", "book_confirmed", "LD001", "", 0, "", "普通话", "PV001"],
        ["V0001", "2026-11-22T11:00:00+08:00", "book_guide", "LD001", "", 0, "", "普通话", "PV002"],
        ["V0001", "2026-11-22T11:20:00+08:00", "book_confirmed", "LD001", "", 0, "", "普通话", "PV002"],
    ])
    m = evaluation.avg_confirmation_minutes(ev)
    assert m["n_confirmations"] == 2
    assert m["avg_confirmation_minutes"] == pytest.approx(25.0)


def test_proxy_eval_metrics_in_range(ctx, events):
    queries = evaluation.build_queries(events, ctx["guides"])
    m = evaluation.run_proxy_eval(ctx, events, queries)
    assert m["n_queries"] == len(queries)
    assert 0.0 <= m["top1_hit_rate"] <= 1.0
    assert 0.0 <= m["top3_coverage"] <= 1.0
    assert 0.0 <= m["baseline_top1_hit_rate"] <= 1.0
    assert m["language_filter_correctness"] == 1.0
    # 覆盖式推荐 ≥ 单点命中
    assert m["top3_coverage"] >= m["top1_hit_rate"]


def test_build_queries_ground_truth_is_guide(ctx, events):
    queries = evaluation.build_queries(events, ctx["guides"])
    guide_ids = {g["person_id"] for g in ctx["guides"]}
    for q in queries:
        assert q["ground_truth"] in guide_ids
        assert q["target_point_id"] in ctx["points_by_id"]
