"""评测执行器（runner）与桩函数的行为测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import registry
import runner
import stubs

PKG_DIR = Path(__file__).resolve().parents[1]


def test_stub_returns_null_and_not_implemented():
    impl = stubs.stub_impl("kg_recommendation_ctr", "kg-recommend")
    result = impl()
    assert result["value"] is None
    assert result["status"] == "not_implemented"
    assert result["note"]
    assert result["n"] == 0


def test_register_stubs_covers_unimplemented_packs():
    created = stubs.register_stubs()
    assert "kg_recommendation_ctr" in created
    assert "booking_usage_rate" in created
    assert "voice_naturalness_mos" in created
    assert "core_availability_rate" in created


def test_run_all_metrics_reports_status():
    summary = runner.run()
    assert summary["totals"]["metrics"] >= 11
    assert summary["totals"]["not_implemented"] >= 1
    assert summary["totals"]["computed"] >= 1
    for result in summary["metrics"]:
        assert result["status"] in ("computed", "not_implemented", "error")
        if result["status"] == "not_implemented":
            assert result["value"] is None  # 桩不编造数字
        assert result["note"]


def test_run_with_only_filter():
    summary = runner.run(only=["parking_mae_ratio_1h"])
    assert len(summary["metrics"]) == 1
    assert summary["metrics"][0]["name"] == "parking_mae_ratio_1h"


def test_run_with_pack_filter():
    summary = runner.run(pack=["parking-forecast"])
    assert summary["metrics"]
    assert all(r["pack"] == "parking-forecast" for r in summary["metrics"])


def test_parking_mae_metric_is_computed_and_judged():
    summary = runner.run(only=["parking_mae_ratio_1h"])
    result = summary["metrics"][0]
    assert result["status"] == "computed"
    assert result["value"] is not None
    assert result["value"] <= 0.20
    assert result["passed"] is True
    assert result["n"] > 0


def test_write_reports_creates_json_and_markdown(tmp_path):
    summary = runner.run()
    paths = runner.write_reports(summary, tmp_path)
    assert paths["json"].exists()
    assert paths["markdown"].exists()
    payload = json.loads(paths["json"].read_text(encoding="utf-8"))
    assert payload["totals"]["metrics"] == len(payload["metrics"])
    markdown = paths["markdown"].read_text(encoding="utf-8")
    assert "| 指标名 |" in markdown
    assert "parking_mae_ratio_1h" in markdown
    assert "口径引用" in markdown
    assert "synthetic" in markdown


def test_markdown_contains_unimplemented_section():
    summary = runner.run()
    markdown = runner.render_markdown(summary)
    assert "## 未实现指标" in markdown
    assert "not_implemented" not in markdown  # 状态用中文展示


def test_strict_mode_exit_code(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "DEFAULT_OUT", tmp_path)
    code = runner.main(["--strict", "--out", str(tmp_path)])
    assert code == 1  # 存在未实现指标 → 非 0


def test_non_strict_exit_code_is_zero(tmp_path):
    code = runner.main(["--out", str(tmp_path)])
    assert code == 0


def test_error_in_one_metric_does_not_break_the_run(monkeypatch):
    def boom():
        raise RuntimeError("故意炸的")

    original = registry.get_metric("parking_mae_ratio_1h").impl
    registry.get_metric("parking_mae_ratio_1h").impl = boom
    try:
        summary = runner.run(only=["parking_mae_ratio_1h", "route_adoption_rate"])
        statuses = {r["name"]: r["status"] for r in summary["metrics"]}
        assert statuses["parking_mae_ratio_1h"] == "error"
        assert statuses["route_adoption_rate"] == "computed"
    finally:
        registry.get_metric("parking_mae_ratio_1h").impl = original
