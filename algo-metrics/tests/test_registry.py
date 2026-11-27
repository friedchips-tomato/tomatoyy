"""注册表与口径声明的一致性测试。"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import registry

PKG_DIR = Path(__file__).resolve().parents[1]
DOC = PKG_DIR / "docs" / "metrics-definition.md"

# 口径书里每个小节前面的显式锚点：<a id="2-8-未来-1-小时车位预测-mae"></a>
ANCHOR_PATTERN = re.compile(r'<a id="([^"]+)"></a>')

REQUIRED_FIELDS = [
    "name", "title", "pack", "definition", "formula", "numerator", "denominator",
    "data_source", "sample_requirement", "boundary", "example", "unit",
    "target_display", "doc_ref",
]


def _doc_sections():
    """把口径书按显式锚点切成 ``{锚点: 小节正文}``。"""
    parts = ANCHOR_PATTERN.split(DOC.read_text(encoding="utf-8"))
    return {parts[i]: parts[i + 1] for i in range(1, len(parts), 2)}


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
    """每个指标的 doc_ref 都要指向口径书里真实存在的小节。

    校验两件事（比原来更严）：

    1. ``doc_ref`` 的锚点能在口径书里解析到（口径书每个小节前都有 ``<a id="...">`` 显式锚点）；
    2. 该小节正文里**登记了这条指标名**（口径书的「框架对应」段落会列出注册表条目名）。

    为什么不用「指标标题前 6 个字是否出现在全文里」这种写法：那是拿**展示标题**
    去猜**小节标题**，措辞不一致就会假失败——例如两个性能指标的标题是
    「首屏加载时间（p95）」「关键页面响应时间（p95）」，而 §2.10 的小节标题叫
    「首屏加载 / 关键页面响应」，doc_ref 锚点本身却是完全正确的。
    """
    sections = _doc_sections()
    assert sections, "口径书里没有任何显式锚点 <a id=...>，doc_ref 无从解析"
    for spec in registry.list_metrics():
        assert spec.doc_ref.startswith("docs/metrics-definition.md#"), spec.name
        anchor = spec.doc_ref.split("#")[-1]
        assert anchor, spec.name
        assert anchor in sections, "%s 的 doc_ref 锚点 %s 在口径书里不存在" % (spec.name, anchor)
        assert spec.name in sections[anchor], (
            "%s 的口径小节 %s 里没有登记该指标名" % (spec.name, anchor)
        )


def test_data_dictionary_covers_contract_views():
    """数据字典要按**视图名**组织，并标出与 DDL 对齐的 TODO 与负责人。

    口径书的「配套」指向 ``algo-metrics/docs/data-dictionary.md``；
    数据字典本身不定义表结构，凡未落地的视图/字段一律标 TODO 并写明负责人。
    """
    dictionary = (PKG_DIR / "docs" / "data-dictionary.md").read_text(encoding="utf-8")
    for view in [
        "algo_points",
        "algo_parking_lots",
        "algo_parking_history",
        "algo_guides",
        "algo_visitor_events",
        "algo_kg_entities",
        "algo_kg_relations",
        "ml_parking_lots",
        "ml_parking_observations",
    ]:
        assert view in dictionary, "数据字典缺少视图 %s" % view
    # 与 DDL 对齐的待办必须写明负责人
    assert "TODO: 与 DDL 对齐（负责人：数据库设计指挥）" in dictionary
    # 数据字典不得自行定义表结构（不得出现建表语句）
    assert "CREATE TABLE" not in dictionary


def test_caliber_book_states_evidence_rule_and_column_policy():
    """口径书必须写明两件与 DB 侧对齐后才成立的事。

    1. **证据等级是硬门槛**：真实精度验收必须筛 ``evidence='operational'``，
       ``evidence='demo'`` 的合成样本不得当成真实达成结论；
    2. **消费侧按列名解析，不要按列数硬校验**：DB 侧只保证前 10 列按位不变，
       新列（``quality`` / ``age_seconds`` / ``evidence``）追加在末尾。
    """
    text = DOC.read_text(encoding="utf-8")
    assert "evidence='operational'" in text
    assert "evidence='demo'" in text
    assert "按列名解析" in text
    assert "不要按列数硬校验" in text
    # 停车消费视图的 13 列清单
    for column in ["quality", "age_seconds", "evidence"]:
        assert column in text, column


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
