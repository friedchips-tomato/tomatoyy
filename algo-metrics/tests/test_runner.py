"""评测执行器（runner）与桩函数的行为测试。"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

import registry
import runner
import stubs

PKG_DIR = Path(__file__).resolve().parents[1]


class _AsciiOnlyConsole(io.TextIOWrapper):
    """模拟「只能编码 ASCII」的控制台。

    * 编码是 ASCII，非 ASCII 字符写出去就抛 ``UnicodeEncodeError``；
    * ``reconfigure`` 不受支持（像某些被包装过的输出流），
      用来验证兜底逻辑在**无法重新配置**时也不会崩。
    """

    def __init__(self, buffer, order=None):
        super().__init__(buffer, encoding="ascii", errors="strict", newline="")
        self.order = order if order is not None else []

    def reconfigure(self, **kwargs):
        raise io.UnsupportedOperation("reconfigure")

    def write(self, text):
        self.order.append("print")
        return super().write(text)


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
        # 口径书 §4 要求的展示位：data_source / verified 缺一不得进报告
        assert result["data_source"]
        assert result["verified"] is False  # 合成数据一律未核验


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
    assert "verified" in markdown
    # 报告不得把合成数据上的比较写成「真实达标」
    assert "不代表真实业务达标" in markdown


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


def test_error_result_keeps_reason_and_continues():
    """出错指标要记下原因与样本量为 0，其余指标照常计算。"""
    def boom():
        raise RuntimeError("故意炸的")

    original = registry.get_metric("parking_mae_ratio_1h").impl
    registry.get_metric("parking_mae_ratio_1h").impl = boom
    try:
        summary = runner.run(only=["parking_mae_ratio_1h", "route_adoption_rate"])
    finally:
        registry.get_metric("parking_mae_ratio_1h").impl = original
    failed = [r for r in summary["metrics"] if r["name"] == "parking_mae_ratio_1h"][0]
    assert failed["status"] == "error"
    assert failed["value"] is None       # 出错不得有数值
    assert failed["n"] == 0
    assert "故意炸的" in failed["note"]
    assert summary["totals"]["error"] == 1
    assert summary["totals"]["computed"] >= 1


def test_bootstrap_does_not_override_registered_impl():
    """框架自带的离线适配器**不得**顶掉已注册的实现。

    runner 每轮都会 bootstrap 一遍；若适配器直接覆盖，
    归属包交付后注册的实现（以及单测里替换的实现来验证异常路径）
    会被悄悄顶掉，指标就会算出「看起来正常」的值。
    """
    spec = registry.get_metric("route_adoption_rate")
    original = spec.impl

    def custom():
        return {"value": 0.123, "unit": "ratio", "n": 7, "note": "自定义实现"}

    spec.impl = custom
    try:
        summary = runner.run(only=["route_adoption_rate"])
    finally:
        spec.impl = original
    result = summary["metrics"][0]
    assert result["status"] == "computed"
    assert result["value"] == pytest.approx(0.123)
    assert result["note"] == "自定义实现"


def test_main_runs_on_ascii_only_console(tmp_path, monkeypatch):
    """控制台只能编码 ASCII 时：不抛异常，且**报告文件照常写出来**。

    复现的是 Windows 默认 GBK 控制台下的真实故障：``print(render_markdown(...))``
    遇到 ``⏳`` 抛 ``UnicodeEncodeError``，而打印发生在落盘之前，
    于是 ``reports/eval-summary.json`` / ``.md`` 根本没机会生成。
    """
    order = []
    console = _AsciiOnlyConsole(io.BytesIO(), order)

    real_write_reports = runner.write_reports

    def spy_write_reports(summary, out_dir=runner.DEFAULT_OUT):
        order.append("write")
        return real_write_reports(summary, out_dir)

    monkeypatch.setattr(runner, "write_reports", spy_write_reports)
    monkeypatch.setattr(sys, "stdout", console)
    try:
        code = runner.main(["--out", str(tmp_path)])
    finally:
        console.flush()

    # 不抛异常，退出码正常
    assert code == 0
    # 两个报告文件都真的写出来了
    assert (tmp_path / "eval-summary.json").exists()
    assert (tmp_path / "eval-summary.md").exists()
    payload = json.loads((tmp_path / "eval-summary.json").read_text(encoding="utf-8"))
    assert payload["totals"]["metrics"] == len(payload["metrics"])
    # 落盘早于打印：控制台出问题也不能让报告丢失
    assert order.index("write") < order.index("print")
    # 报告文件里保留原始符号（文件不受控制台编码影响）
    markdown = (tmp_path / "eval-summary.md").read_text(encoding="utf-8")
    assert "⏳" in markdown


def test_console_text_degrades_exotic_symbols():
    """控制台降级：生僻符号换成 ASCII 标记，中文原样保留。"""
    text = runner.console_text("✅ 达标 / ⚠️ 未达标 / ➖ 并列 / ⏳ 未实现 / ❌ 异常 / a − b")
    for symbol in ["✅", "⚠", "➖", "⏳", "❌", "−"]:
        assert symbol not in text, symbol
    assert "[OK]" in text and "[!]" in text and "[-]" in text
    assert "[..]" in text and "[X]" in text
    assert "a - b" in text
    # 中文不受影响
    assert "未实现" in text

