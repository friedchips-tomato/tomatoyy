"""algo-metrics 入口（任务 M4 · 指标口径与离线评测框架）。

跑一次就能看到：**指标清单 + 每个指标的状态 + 能算的指标的数值**。

用法::

    python algo-metrics/main.py                    # 清单 + 跑一遍可算的指标
    python algo-metrics/main.py --pack parking-forecast
    python algo-metrics/main.py --only parking_mae_ratio_1h
    python algo-metrics/main.py --json             # 机器可读输出

完整的报告（JSON + Markdown）用 ``python algo-metrics/runner.py`` 生成。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import registry  # noqa: E402
import runner  # noqa: E402

PACK_LABELS = {
    "route-recommender": "路线推荐",
    "kg-recommend": "知识图谱语义推荐",
    "ai-narration": "AI 讲解（后续包）",
    "guide-match-profile": "讲解员匹配与游客画像",
    "parking-forecast": "停车预测与推荐",
    "performance": "性能",
    "system": "系统",
}


def _fmt(result: Dict[str, Any]) -> str:
    return runner._format_value(result)


def _status(result: Dict[str, Any]) -> str:
    return runner._status_text(result)


def print_catalog(summary: Dict[str, Any]) -> None:
    """打印指标清单（名称、目标、归属包、口径引用、状态）。"""
    print("=" * 100)
    print("指标清单（共 %d 项）" % summary["totals"]["metrics"])
    print("=" * 100)
    print("%-34s %-22s %-14s %-8s %-10s %s" % (
        "指标名", "归属包", "目标值", "角色", "状态", "口径引用"))
    print("-" * 100)
    for result in summary["metrics"]:
        print("%-34s %-22s %-14s %-8s %-10s %s" % (
            result["name"],
            PACK_LABELS.get(result["pack"], result["pack"]),
            result.get("target", "—"),
            "主" if result.get("role", "primary") == "primary" else "辅",
            _status(result),
            result.get("doc_ref", ""),
        ))
    print()


def print_values(summary: Dict[str, Any]) -> None:
    """打印可算指标的数值与样本量。"""
    computed = [r for r in summary["metrics"] if r.get("status") == "computed"]
    pending = [r for r in summary["metrics"] if r.get("status") != "computed"]
    print("=" * 100)
    print("本次可计算指标（%d 项；数据来源 synthetic，仅验证工程链路）" % len(computed))
    print("=" * 100)
    for result in computed:
        print("- %s（%s）" % (result["name"], result["title"]))
        print("    结果=%s  目标=%s  样本量=%s" % (
            _fmt(result), result.get("target", "—"), result.get("n", 0)))
        if result.get("note"):
            print("    口径：%s" % result["note"])
    print()
    if pending:
        print("=" * 100)
        print("尚未实现指标（%d 项，返回 value=null，不编造数字）" % len(pending))
        print("=" * 100)
        for result in pending:
            print("- %s（%s）：%s" % (result["name"], result["pack"], result.get("note", "")))
        print()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="乐游蓬江 · 指标清单与离线评测")
    parser.add_argument("--only", action="append", default=None, help="只跑指定指标名")
    parser.add_argument("--pack", action="append", default=None, help="只跑指定归属包")
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    args = parser.parse_args(argv)

    # 与 runner 同一套控制台兜底：Windows 默认 GBK 控制台遇到非 ASCII 字符会抛
    # UnicodeEncodeError（详见 runner.make_console_safe）。
    runner.make_console_safe()

    summary = runner.run(only=args.only, pack=args.pack)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    totals = summary["totals"]
    print("乐游蓬江 AI 智慧导览 · 验收指标口径与离线评测（algo-metrics v%s）"
          % registry.FRAMEWORK_VERSION)
    print("契约：%s" % registry.CONTRACT_REF)
    print("数据来源：%s —— %s" % (summary["data_source"], summary["data_source_note"]))
    print()
    print_catalog(summary)
    print_values(summary)
    print("-" * 100)
    print("汇总：共 %d 项，已算 %d 项（达标 %d / 未达标 %d / 并列口径 %d），未实现 %d 项，异常 %d 项"
          % (totals["metrics"], totals["computed"], totals["passed"], totals["failed"],
             totals["unjudged"], totals["not_implemented"], totals["error"]))
    print("完整报告（JSON + Markdown）：python algo-metrics/runner.py")
    print("口径正文：algo-metrics/docs/metrics-definition.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
