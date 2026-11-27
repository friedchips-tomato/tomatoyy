"""``compute.py`` 通用算子的正确性与边界测试。"""

from __future__ import annotations

import math

import pytest

import compute


# --------------------------------------------------------------------------------------
# 采纳率 / 点击率
# --------------------------------------------------------------------------------------


def _events(rows):
    return [
        {"visitor_id": v, "ts": ts, "event_type": t, "route_id": r}
        for v, ts, t, r in rows
    ]


def test_adoption_rate_dedup_by_visitor():
    events = _events([
        ("V1", "2026-10-05T10:00:00+08:00", "view_route", "R1"),
        ("V1", "2026-10-05T10:05:00+08:00", "view_route", "R2"),
        ("V1", "2026-10-05T11:00:00+08:00", "finish_route", "R1"),
        ("V2", "2026-10-05T10:00:00+08:00", "view_route", "R3"),
    ])
    result = compute.compute_adoption_rate(events, "view_route", "finish_route")
    assert result["denominator"] == 2  # V1、V2 两位访客拿到推荐
    assert result["numerator"] == 1  # 只有 V1 完成
    assert result["value"] == pytest.approx(0.5)
    assert result["unit"] == "ratio"
    assert result["n"] == 2


def test_adoption_rate_window_and_route_matching():
    events = _events([
        ("V1", "2026-10-05T10:00:00+08:00", "view_route", "R1"),
        ("V1", "2026-10-06T23:00:00+08:00", "finish_route", "R1"),  # 超窗
        ("V1", "2026-10-05T12:00:00+08:00", "finish_route", "R9"),  # 路线不匹配
    ])
    result = compute.compute_adoption_rate(
        events, "view_route", "finish_route",
        dedup_key="visitor_id", window_minutes=60, match_field="route_id",
    )
    assert result["numerator"] == 0
    assert result["value"] == 0.0
    assert "窗口外动作剔除" in result["note"]
    assert "字段不匹配动作剔除" in result["note"]


def test_adoption_rate_event_level_when_dedup_none():
    events = _events([
        ("V1", "2026-10-05T10:00:00+08:00", "view_route", "R1"),
        ("V2", "2026-10-05T10:00:00+08:00", "view_route", "R2"),
        ("V1", "2026-10-05T10:30:00+08:00", "finish_route", "R1"),
        ("V1", "2026-10-05T10:40:00+08:00", "finish_route", "R1"),
    ])
    result = compute.compute_adoption_rate(
        events, "view_route", "finish_route", dedup_key=None
    )
    assert result["denominator"] == 2   # 两次展示
    assert result["numerator"] == 2   # 两次完成
    assert result["value"] == pytest.approx(1.0)


def test_adoption_rate_empty_events_returns_none():
    result = compute.compute_adoption_rate([], "view_route", "finish_route")
    assert result["value"] is None
    assert result["denominator"] == 0
    assert "空样本" in result["note"]


def test_click_rate_counts_unique_impressions():
    events = [
        {"impression_id": "I1", "event_type": "impression"},
        {"impression_id": "I1", "event_type": "click"},
        {"impression_id": "I1", "event_type": "click"},
        {"impression_id": "I2", "event_type": "impression"},
    ]
    result = compute.compute_click_rate(events, "impression", "click")
    assert result["denominator"] == 2
    assert result["numerator"] == 1
    assert result["value"] == pytest.approx(0.5)


def test_click_rate_empty_returns_none():
    result = compute.compute_click_rate([], "impression", "click")
    assert result["value"] is None
    assert result["note"]


# --------------------------------------------------------------------------------------
# MAE 与其它误差指标
# --------------------------------------------------------------------------------------


def test_mae_ratio_caliber_conversion():
    """MAE_ratio = MAE_spaces / total_spaces（主口径换算）。"""
    result = compute.compute_mae([90, 80], [100, 70], 100)
    assert result["mae_spaces"] == pytest.approx(10.0)
    assert result["mae_ratio"] == pytest.approx(0.10)
    assert result["mae_pp"] == pytest.approx(10.0)
    assert result["value"] == pytest.approx(0.10)
    assert result["unit"] == "ratio"
    assert result["caliber"] == "mae_ratio"


def test_mae_matches_task_numeric_example():
    """任务书数值例子：total=100、平均绝对误差 8 → MAE_ratio=8%、MAE_spaces=8、MAE_pp=8。"""
    result = compute.compute_mae([92, 88], [100, 80], 100)
    assert result["mae_spaces"] == pytest.approx(8.0)
    assert result["mae_ratio"] == pytest.approx(0.08)
    assert result["mae_pp"] == pytest.approx(8.0)


def test_mae_pooled_ratio_matches_parking_forecast_pct_b():
    """多车场汇总口径 = Σ|e| / Σ(total_spaces) = mae / mean(total_spaces)。"""
    y_true = [10, 20, 30]
    y_pred = [12, 18, 25]
    totals = [100, 120, 80]
    result = compute.compute_mae(y_true, y_pred, totals)
    mae = sum(abs(p - a) for a, p in zip(y_true, y_pred)) / 3
    assert result["mae_ratio"] == pytest.approx(mae / (sum(totals) / 3))
    assert result["mae_spaces"] == pytest.approx(mae)


def test_mae_without_total_spaces_is_spaces_caliber():
    result = compute.compute_mae([10, 20], [12, 18])
    assert result["value"] == pytest.approx(2.0)
    assert result["unit"] == "spaces"
    assert result["mae_ratio"] is None
    assert result["mae_pp"] is None


def test_mae_skips_missing_values_and_reports_excluded():
    result = compute.compute_mae([10, None, 30], [12, 20, 25], 100)
    assert result["n"] == 2
    assert result["n_excluded"] == 1
    assert result["mae_spaces"] == pytest.approx(3.5)  # (|12-10| + |25-30|) / 2


def test_mae_empty_sample_returns_none():
    result = compute.compute_mae([], [], 100)
    assert result["value"] is None
    assert result["n"] == 0
    assert "空样本" in result["note"]


def test_mae_zero_total_spaces_falls_back_to_spaces():
    result = compute.compute_mae([10, 20], [12, 18], 0)
    assert result["mae_ratio"] is None
    assert result["value"] == pytest.approx(2.0)
    assert result["unit"] == "spaces"


def test_mape_excludes_zero_actual():
    result = compute.compute_mape([10, 0, 20], [12, 5, 18])
    assert result["n"] == 3
    assert result["n_used"] == 2
    assert result["excluded_ratio"] == pytest.approx(1 / 3)
    assert result["value"] == pytest.approx((0.2 + 0.1) / 2)


def test_mape_all_zero_actual_returns_none():
    result = compute.compute_mape([0, 0], [1, 2])
    assert result["value"] is None
    assert "MAPE 无定义" in result["note"]


def test_rmse():
    result = compute.compute_rmse([3, -3], [0, 0])
    assert result["value"] == pytest.approx(3.0)
    assert result["unit"] == "spaces"


def test_rmse_empty_returns_none():
    assert compute.compute_rmse([], [])["value"] is None


def test_wape_ratio_of_sums():
    result = compute.compute_wape([10, 20], [15, 30])
    assert result["value"] == pytest.approx((5 + 10) / 30)
    assert result["unit"] == "ratio"


def test_wape_with_weights():
    result = compute.compute_wape([10, 20], [15, 30], weights=[2, 1])
    assert result["value"] == pytest.approx((2 * 5 + 1 * 10) / (2 * 10 + 1 * 20))


def test_wape_zero_denominator_returns_none():
    result = compute.compute_wape([0, 0], [1, 2])
    assert result["value"] is None
    assert "分母为 0" in result["note"]


def test_hit_rate_threshold_one_spaces():
    result = compute.compute_hit_rate([10, 20, 30], [11, 19, 35], 1.0)
    assert result["numerator"] == 2
    assert result["denominator"] == 3
    assert result["value"] == pytest.approx(2 / 3)


def test_hit_rate_invalid_threshold():
    result = compute.compute_hit_rate([10], [10], -1)
    assert result["value"] is None


# --------------------------------------------------------------------------------------
# 时延 / 时长 / 可用率
# --------------------------------------------------------------------------------------


def test_latency_percentiles():
    samples = list(range(1, 101))  # 1..100
    result = compute.compute_latency_ms(samples)
    assert result["n"] == 100
    assert result["p50"] == pytest.approx(50.5)
    assert result["p95"] == pytest.approx(95.05)
    assert result["max"] == 100
    assert result["mean"] == pytest.approx(50.5)


def test_latency_accepts_dict_samples():
    result = compute.compute_latency_ms([{"latency_ms": 100}, {"ms": 200}, {"x": 1}])
    assert result["n"] == 2
    assert result["max"] == 200


def test_latency_empty_returns_none():
    result = compute.compute_latency_ms([])
    assert result["value"] is None
    assert result["p95"] is None
    assert "空样本" in result["note"]


def test_duration_minutes_basic():
    starts = ["2026-10-05T10:00:00+08:00", "2026-10-05T11:00:00+08:00"]
    ends = ["2026-10-05T10:20:00+08:00", "2026-10-05T11:40:00+08:00"]
    result = compute.compute_duration_minutes(starts, ends)
    assert result["n"] == 2
    assert result["value"] == pytest.approx(30.0)
    assert result["unit"] == "minutes"


def test_duration_minutes_excludes_cancelled():
    starts = ["2026-10-05T10:00:00+08:00", "2026-10-05T11:00:00+08:00"]
    ends = ["2026-10-05T10:20:00+08:00", "2026-10-05T11:10:00+08:00"]
    result = compute.compute_duration_minutes(
        starts, ends, exclude_cancelled=True, cancelled=[False, True]
    )
    assert result["n"] == 1
    assert result["value"] == pytest.approx(20.0)
    assert result["n_cancelled"] == 1


def test_duration_minutes_keeps_cancelled_when_asked():
    starts = ["2026-10-05T10:00:00+08:00", "2026-10-05T11:00:00+08:00"]
    ends = ["2026-10-05T10:20:00+08:00", "2026-10-05T11:10:00+08:00"]
    result = compute.compute_duration_minutes(
        starts, ends, exclude_cancelled=False, cancelled=[False, True]
    )
    assert result["n"] == 2
    assert result["value"] == pytest.approx(15.0)


def test_duration_minutes_dict_input():
    records = [
        {"ts": "2026-10-05T10:00:00+08:00", "end": "2026-10-05T10:15:00+08:00"},
        {"ts": "2026-10-05T11:00:00+08:00", "end": "2026-10-05T11:45:00+08:00",
         "status": "cancelled"},
    ]
    result = compute.compute_duration_minutes(records, records)
    assert result["n"] == 1
    assert result["value"] == pytest.approx(15.0)
    assert result["n_cancelled"] == 1


def test_duration_minutes_empty_returns_none():
    result = compute.compute_duration_minutes([], [])
    assert result["value"] is None
    assert "空样本" in result["note"]


def test_availability_normal_and_zero_denominator():
    ok = compute.compute_availability(995, 1000)
    assert ok["value"] == pytest.approx(0.995)
    assert ok["numerator"] == 995
    assert ok["denominator"] == 1000

    zero = compute.compute_availability(0, 0)
    assert zero["value"] is None
    assert "分母为 0" in zero["note"]
    assert zero["n"] == 0


def test_availability_invalid_counts():
    result = compute.compute_availability(10, 5)
    assert result["value"] is None
    assert "超出" in result["note"]


def test_length_mismatch_raises():
    with pytest.raises(ValueError):
        compute.compute_mae([1, 2], [1])
