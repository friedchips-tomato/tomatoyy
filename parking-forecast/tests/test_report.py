"""阶段 2 防回归：report.md 必须是换行分隔的正常 markdown，而不是一整行。

回归点：scripts/report.py 曾用 ``"".join(L)`` 把逐段文本拼成一行，
导致 markdown 标题与表格全部失效（只有 metrics.json 是对的）。本测试重新生成报告
并断言标题/表头/数据行各自独立成行。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

import report  # noqa: E402


def test_report_md_is_newline_delimited_markdown():
    # 重新生成 artifacts（与可复算命令 PYTHONPATH=src python scripts/report.py 一致）
    assert report.main() == 0

    text = (ROOT / "artifacts" / "report.md").read_text(encoding="utf-8")
    assert "\n" in text
    assert "\r" not in text  # 保持 LF，不混入 CR
    lines = text.split("\n")

    # 标题以 "# " 开头，且后面紧跟换行（第二行是空行，符合 markdown 惯例）
    assert lines[0].startswith("# ")
    assert lines[1] == ""

    # 主口径表头独立成行
    assert "| 方法 | MAE（车位） | RMSE | WAPE% | 空置率 MAE（pp） | Bias | 命中率 | n |" in lines

    # 表格数据行逐行渲染（模型 + 三基线）
    assert any(l.startswith("| 模型（D0） |") for l in lines)
    assert any(l.startswith("| B1 last_known |") for l in lines)
    assert any(l.startswith("| B2 same_slot_median |") for l in lines)
    assert any(l.startswith("| B3 same_weekday_mean |") for l in lines)

    # 四口径表与降级覆盖表也各自成行
    assert any("| **D WAPE（采用）** |" in l for l in lines)
    assert any(l.startswith("| method | 级别 | 触发次数 | MAE（车位） |") for l in lines)
