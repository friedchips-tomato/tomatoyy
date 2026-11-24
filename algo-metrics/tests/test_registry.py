"""注册表与口径声明的一致性测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

import registry

PKG_DIR = Path(__file__).resolve().parents[1]
DOC = PKG_DIR / "docs" / "metrics-definition.md"

REQUIRED_FIELDS = [
    "name", "title", "pack", "definition", "formula", "numerator", "denominator",
    "data_source", "sample_requirement", "boundary", "example", "unit",
    "target_display", "doc_ref",
]


def test_registry_not_empty():
    assert len(registry.list_metrics()) >= 11


def test_every_metric_declares_full_caliber():
    for spec in registry.list_metrics():
        for field in REQUIRED_FIELDS:
            value = getattr(spec, field)
            assert value not in (None, ""), "%s 缺少字段 %s" % (spec.name, field)


def test_requirement_metric_names_are_covered():
    """需求书/任务书要求的 11 项验收指标都要在注册表里。"""
    names = {spec.name for spec in registry.list_metrics()}
    for expected in [
        "route_generation_latency_ms",
        "route_adoption_rate",
        "kg_recommendation_ctr",
        "voice_naturalness_mos",
        "guide_point_match_accuracy",
        "booking_usage_rate",
        "booking_confirmation_duration_min",
        "parking_mae_ratio_1h",
        "parking_offpeak_adoption_rate",
        "first_screen_load_ms",
        "page_response_ms_p95",
        "core_availability_rate",
    ]:
        assert expected in names


def test_targets_match_requirement_book():
    expected = {
        "route_generation_latency_ms": ("<=", 3000.0),
        "route_adoption_rate": (">=", 0.40),
        "kg_recommendation_ctr": (">=", 0.25),
        "voice_naturalness_mos": (">=", 3.8),
        "guide_point_match_accuracy": (">=", 0.90),
        "booking_usage_rate": (">=", 0.30),
        "booking_confirmation_duration_min": ("<=", 30.0),
        "parking_mae_ratio_1h": ("<=", 0.20),
        "parking_offpeak_adoption_rate": (">=", 0.25),
        "first_screen_load_ms": ("<=", 2000.0),
        "page_response_ms_p95": ("<=", 1500.0),
        "core_availability_rate": (">=", 0.995),
    }
    for name, (op, value) in expected.items():
        spec = registry.get_metric(name)
        assert spec is not None, name
        assert spec.target_op == op, name
        assert spec.target_value == pytest.approx(value), name


def test_doc_ref_points_to_existing_section():
    """每个指标的 doc_ref 都要能在口径书里找到对应小节标题。"""
    text = DOC.read_text(encoding="utf-8")
    for spec in registry.list_metrics():
        anchor = spec.doc_ref.split("#")[-1]
        assert anchor, spec.name
        # 口径书小节标题形如 "## 2.8 未来 1 小时车位预测 MAE"
        title = spec.title.split("（")[0].strip()
        assert title.split("（")[0][:6] in text, "%s 的口径小节标题未出现在口径书" % spec.name


def test_filter_metrics_by_pack_and_name():
    parking = registry.filter_metrics(pack=["parking-forecast"])
    assert parking
    assert all(spec.pack == "parking-forecast" for spec in parking)

    only = registry.filter_metrics(only=["parking_mae_ratio_1h"])
    assert len(only) == 1
    assert only[0].name == "parking_mae_ratio_1h"


def test_check_target_respects_direction():
    spec = registry.get_metric("parking_mae_ratio_1h")
    assert registry.check_target(spec, 0.10) is True
    assert registry.check_target(spec, 0.30) is False
    assert registry.check_target(spec, None) is None

    spec2 = registry.get_metric("route_adoption_rate")
    assert registry.check_target(spec2, 0.45) is True
    assert registry.check_target(spec2, 0.10) is False


def test_register_pack_metrics_overrides_stub():
    spec = registry.get_metric("kg_recommendation_ctr")
    original = spec.impl
    try:
        registry.register_pack_metrics(
            "kg-recommend",
            {"kg_recommendation_ctr": lambda: {"value": 0.3, "unit": "ratio", "n": 10,
                                               "note": "来自 kg 包"}},
        )
        assert spec.impl is not original
        result = registry.evaluate_metric(spec)
        assert result["value"] == pytest.approx(0.3)
        assert result["status"] == "computed"
    finally:
        spec.impl = original
