"""评测执行器（algo-metrics / 任务 M4）。

按指标名调用各包的计算函数，产出汇总 JSON + Markdown 表。

用法::

    python algo-metrics/runner.py                     # 全量跑一遍并写 reports/
    python algo-metrics/runner.py --pack parking-forecast
    python algo-metrics/runner.py --only parking_mae_ratio_1h
    python algo-metrics/runner.py --strict            # 有未实现指标时退出码非 0

**红线**：未实现的包走 ``stubs.py`` 的桩，返回 ``value=null`` 与
``status=not_implemented``，**不编造数字**；执行器也不会因为某个指标异常而中断整轮。
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import adapters  # noqa: E402
import registry  # noqa: E402
import stubs  # noqa: E402

DEFAULT_OUT = HERE / "reports"
FRAMEWORK_NAME = "algo-metrics"

STATUS_COMPUTED = "computed"
STATUS_STUB = "not_implemented"
STATUS_ERROR = "error"


def _now_iso() -> str:
    tz = timezone(timedelta(hours=8))
    return datetime.now(tz).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def bootstrap() -> None:
    """注册离线评测实现与未交付包的桩。

    可重复调用：只**补齐缺失**的实现，不覆盖已经注册好的实现
    （归属包交付后注册的实现、单测里替换的实现都优先，见 ``adapters.register_adapters``）。
    """
    stubs.register_stubs()
    adapters.register_adapters()


def run(
    only: Optional[Sequence[str]] = None,
    pack: Optional[Sequence[str]] = None,
    data_source: str = "synthetic",
) -> Dict[str, Any]:
    """执行一轮评测，返回汇总结构。

    :param only: 只跑这些指标名。
    :param pack: 只跑这些归属包。
    :param data_source: 本轮评测所用数据的来源标注（默认 synthetic）。
    """
    bootstrap()
    specs = registry.filter_metrics(only=list(only) if only else None,
                                    pack=list(pack) if pack else None)
    results: List[Dict[str, Any]] = []
    for spec in specs:
        try:
            result = registry.evaluate_metric(spec)
        except Exception as exc:  # 单个指标失败不影响整轮
            result = {
                "name": spec.name,
                "title": spec.title,
                "pack": spec.pack,
                "value": None,
                "unit": spec.unit,
                "status": STATUS_ERROR,
                "target": spec.target_display,
                "passed": None,
                "n": 0,
                "note": "执行异常：%s" % exc,
                "traceback": traceback.format_exc(limit=3),
                "doc_ref": spec.doc_ref,
                "data_source": spec.data_source,
                "evidence": spec.evidence,
                "verified": spec.verified,
            }
        results.append(result)

    computed = [r for r in results if r.get("status") == STATUS_COMPUTED]
    stubs_only = [r for r in results if r.get("status") == STATUS_STUB]
    errors = [r for r in results if r.get("status") == STATUS_ERROR]
    primary = [r for r in results if r.get("role", "primary") == "primary"]
    failed = [r for r in primary if r.get("passed") is False]

    summary = {
        "framework": {
            "name": FRAMEWORK_NAME,
            "version": registry.FRAMEWORK_VERSION,
            "contract": registry.CONTRACT_REF,
        },
        "generated_at": _now_iso(),
        "data_source": data_source,
        "data_source_note": (
            "本次评测使用合成评测集（data_source=synthetic、verified=false），"
            "只验证口径与工程链路，不代表真实业务达标；真实数据到位后只换数据文件、不改口径。"
        ),
        "filters": {"only": list(only) if only else None, "pack": list(pack) if pack else None},
        "totals": {
            "metrics": len(results),
            "computed": len(computed),
            "not_implemented": len(stubs_only),
            "error": len(errors),
            "passed": sum(1 for r in primary if r.get("passed") is True),
            "failed": len(failed),
            "unjudged": sum(1 for r in primary if r.get("passed") is None),
        },
        "metrics": results,
    }
    return summary


def _format_value(result: Dict[str, Any]) -> str:
    value = result.get("value")
    if value is None:
        return "—"
    unit = result.get("unit")
    if unit == "ratio":
        return "%.2f%%" % (value * 100)
    if unit == "ms":
        return "%.0f ms" % value
    if unit == "minutes":
        return "%.1f 分钟" % value
    if unit == "spaces":
        return "%.2f 车位" % value
    if unit == "pp":
        return "%.2f pp" % value
    if unit == "score":
        return "%.2f" % value
    return "%s" % value


def _status_text(result: Dict[str, Any]) -> str:
    status = result.get("status", "")
    passed = result.get("passed")
    auxiliary = result.get("role") == "auxiliary"
    suffix = "（辅助）" if auxiliary else ""
    if status == STATUS_COMPUTED:
        if passed is True:
            return "✅ 达标" + suffix
        if passed is False:
            return "⚠️ 未达标" + suffix
        return "➖ 并列口径"
    if status == STATUS_STUB:
        return "⏳ 未实现"
    if status == STATUS_ERROR:
        return "❌ 执行异常"
    return status


def render_markdown(summary: Dict[str, Any]) -> str:
    """把汇总渲染成 Markdown 表（指标名/目标值/本次结果/单位/状态/样本量/口径引用）。"""
    lines: List[str] = []
    add = lines.append
    add("# 验收指标评测汇总（%s v%s）" % (summary["framework"]["name"],
                                       summary["framework"]["version"]))
    add("")
    add("- 生成时间：%s" % summary["generated_at"])
    add("- 数据来源：`%s`" % summary["data_source"])
    add("- 数据核验：`verified=false`（合成数据一律未核验；真实数据到位并核验后由归属包改写）")
    add("- %s" % summary["data_source_note"])
    add("- 契约：%s" % summary["framework"]["contract"])
    add("")
    totals = summary["totals"]
    add("统计：共 %d 项指标，已计算 %d 项，未实现 %d 项，执行异常 %d 项；"
        "已算指标中达标 %d 项、未达标 %d 项。"
        % (totals["metrics"], totals["computed"], totals["not_implemented"],
           totals["error"], totals["passed"], totals["failed"]))
    add("")
    add("| 指标名 | 归属包 | 目标值 | 本次结果 | 单位 | 状态 | 样本量 | 口径引用 |")
    add("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for result in summary["metrics"]:
        add(
            "| `%s`<br/>%s | %s | %s | %s | %s | %s | %s | [%s](%s) |"
            % (
                result["name"],
                result["title"],
                result["pack"],
                result.get("target", "—"),
                _format_value(result),
                result.get("unit") or "—",
                _status_text(result),
                result.get("n", 0),
                result.get("doc_ref", "").split("#")[-1] or "口径书",
                result.get("doc_ref", ""),
            )
        )
    add("")
    add("## 口径要点")
    add("")
    add("- 停车 MAE **主口径**：`MAE_ratio = mean(|pred_free − actual_free|) / total_spaces`"
        "（比例）；并列呈现 `MAE_spaces`（车位）与 `MAE_pp`（百分点），三者分母不同、不可混用。")
    add("- 预测步长：未来 1 小时（30 分钟粒度下为 2 步，horizon=60min）。")
    add("- 缺失桶（`quality=missing`）不进入 MAE 分子分母，其覆盖率单列统计。")
    add("- 采纳率分母：路线=获得推荐的人数；错峰=展示含错峰建议的次数；点击率=曝光数。")
    add("- 状态列的「达标」只表示**本次合成数据上算出的数值与目标值的关系**，"
        "**不代表真实业务达标**；需求方书面确认放在上线阶段。")
    add("- 需求方书面确认放在上线阶段；本阶段按本口径执行，不自称已达标。")
    add("")
    add("## 未实现指标")
    add("")
    pending = [r for r in summary["metrics"] if r.get("status") != STATUS_COMPUTED]
    if not pending:
        add("（无）")
    else:
        for result in pending:
            add("- `%s`（%s）：%s" % (result["name"], result["pack"], result.get("note", "")))
    add("")
    return "\n".join(lines)


def write_reports(summary: Dict[str, Any], out_dir: Path = DEFAULT_OUT) -> Dict[str, Path]:
    """写 ``eval-summary.json`` 与 ``eval-summary.md``。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "eval-summary.json"
    md_path = out_dir / "eval-summary.md"
    json_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    md_path.write_text(render_markdown(summary), encoding="utf-8")
    return {"json": json_path, "markdown": md_path}


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="乐游蓬江 · 验收指标评测执行器")
    parser.add_argument("--only", action="append", default=None,
                        help="只跑指定指标名（可重复）")
    parser.add_argument("--pack", action="append", default=None,
                        help="只跑指定归属包（可重复）")
    parser.add_argument("--out", type=str, default=str(DEFAULT_OUT),
                        help="报告输出目录（默认 algo-metrics/reports）")
    parser.add_argument("--strict", action="store_true",
                        help="存在未实现指标或未达标项时退出码非 0")
    parser.add_argument("--no-write", action="store_true", help="只打印，不写报告文件")
    parser.add_argument("--json", action="store_true", help="把汇总 JSON 打到标准输出")
    args = parser.parse_args(argv)

    summary = run(only=args.only, pack=args.pack)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(render_markdown(summary))
        if not args.no_write:
            paths = write_reports(summary, Path(args.out))
            print("报告已写出：%s / %s" % (paths["json"], paths["markdown"]))

    totals = summary["totals"]
    reasons: List[str] = []
    if totals["not_implemented"]:
        reasons.append("%d 项指标未实现（归属包未交付）" % totals["not_implemented"])
    if totals["error"]:
        reasons.append("%d 项指标执行异常" % totals["error"])
    if totals["failed"]:
        reasons.append("%d 项指标未达目标" % totals["failed"])
    if args.strict and reasons:
        print("[strict] 退出码 1：" + "；".join(reasons), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
