"""离线评测适配层（algo-metrics / 任务 M4）。

把 ``datasets/`` 里的**合成评测集**接到 ``compute.py`` 的通用算子上，得到本框架自测的
指标数值。归属包（route-recommender / kg-recommend / guide-match-profile 等）交付后，
它们会用自己的实现覆盖这些桩，runner 与报告格式不变。

**红线**：本层只从评测集读数，不允许为了「指标好看」改口径或挑样本；
所有结果都带 ``data_source=synthetic`` 标注，只证明工程链路可用，不代表真实业务达标。
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Dict, List, Optional

import compute
import registry

__all__ = ["load_parking_rows", "load_visitor_events", "load_route_impressions",
           "register_adapters", "DATASETS_DIR"]

DATASETS_DIR = Path(__file__).resolve().parent / "datasets"

PARKING_CSV = DATASETS_DIR / "parking_observations_sample.csv"
EVENTS_CSV = DATASETS_DIR / "visitor_events_sample.csv"
IMPRESSIONS_CSV = DATASETS_DIR / "route_impressions_sample.csv"

# 观察窗口（分钟）：路线采纳按 24 小时窗口统计，超窗完成的样本剔除
ROUTE_WINDOW_MINUTES = 24 * 60


def _read_csv(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        raise FileNotFoundError(
            "缺少评测集：%s（先运行 python algo-metrics/datasets/gen_datasets.py）" % path
        )
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def load_parking_rows() -> List[Dict[str, str]]:
    """读停车观测评测集（契约 §4.3 列 + 评测扩展列）。"""
    return _read_csv(PARKING_CSV)


def load_visitor_events() -> List[Dict[str, str]]:
    """读游客事件评测集（契约 §4.5 列 + data_source）。"""
    return _read_csv(EVENTS_CSV)


def load_route_impressions() -> List[Dict[str, str]]:
    """读路线曝光评测集（曝光明细 + adopted 标记）。"""
    return _read_csv(IMPRESSIONS_CSV)


def _parking_eval_sample(rows: List[Dict[str, str]]) -> Dict[str, Any]:
    """按口径书 §2.8 抽取 MAE 评估样本，并统计缺桶覆盖率。

    规则（口径书 §2.8 第 ⑥ 条）：

    * 只用 ``quality='ok'`` 且有预测值的桶进入主口径；
    * ``quality='missing'`` 的缺桶（free_spaces 为空）不进入分子分母，单列覆盖率；
    * ``quality='stale'`` 的过期桶同样不进主口径，单列覆盖率与（若有预测）误差；
    * 评估窗口取 ``split='eval'`` 的桶（预热段只供预测器取历史，不进验收样本）。
    """
    window = [r for r in rows if r.get("split", "eval") == "eval"]
    counts = {"ok": 0, "stale": 0, "missing": 0}
    for row in window:
        quality = row.get("quality", "ok")
        counts[quality] = counts.get(quality, 0) + 1
    total_buckets = len(window) or 1

    usable = [
        r for r in window
        if r.get("quality") == "ok" and r.get("predicted_free_spaces", "") != ""
    ]
    stale_with_pred = [
        r for r in window
        if r.get("quality") == "stale" and r.get("predicted_free_spaces", "") != ""
    ]
    return {
        "window": window,
        "usable": usable,
        "stale_with_pred": stale_with_pred,
        "coverage": {
            "total_buckets": len(window),
            "ok": counts.get("ok", 0),
            "stale": counts.get("stale", 0),
            "missing": counts.get("missing", 0),
            "ok_ratio": counts.get("ok", 0) / total_buckets,
            "stale_ratio": counts.get("stale", 0) / total_buckets,
            "missing_ratio": counts.get("missing", 0) / total_buckets,
        },
    }


def parking_mae_metrics() -> Dict[str, Any]:
    """算出停车预测的三种 MAE 口径（主口径 + 两个并列口径）。"""
    rows = load_parking_rows()
    sample = _parking_eval_sample(rows)
    usable = sample["usable"]
    if not usable:
        return {
            "mae_spaces": None,
            "mae_ratio": None,
            "mae_pp": None,
            "n": 0,
            "coverage": sample["coverage"],
            "per_lot": {},
            "note": "评估窗口内没有 quality=ok 且有预测值的桶",
        }

    y_true = [float(r["free_spaces"]) for r in usable]
    y_pred = [float(r["predicted_free_spaces"]) for r in usable]
    totals = [float(r["total_spaces"]) for r in usable]
    main = compute.compute_mae(y_true, y_pred, totals)

    per_lot: Dict[str, Any] = {}
    for lot in sorted({r["parking_id"] for r in usable}):
        sub = [r for r in usable if r["parking_id"] == lot]
        lot_res = compute.compute_mae(
            [float(r["free_spaces"]) for r in sub],
            [float(r["predicted_free_spaces"]) for r in sub],
            [float(r["total_spaces"]) for r in sub],
        )
        per_lot[lot] = {
            "mae_spaces": lot_res["mae_spaces"],
            "mae_ratio": lot_res["mae_ratio"],
            "mae_pp": lot_res["mae_pp"],
            "n": lot_res["n"],
            "total_spaces": sub[0]["total_spaces"],
        }

    # 辅助监控：命中率 / WAPE / MAPE（与 parking-forecast 产物字段同名同义）
    hit = compute.compute_hit_rate(y_true, y_pred, 1.0)
    wape = compute.compute_wape(y_true, y_pred)
    mape = compute.compute_mape(y_true, y_pred)
    rmse = compute.compute_rmse(y_true, y_pred)

    coverage = sample["coverage"]
    note = (
        "评估窗口=评测集 eval 段（2026-10-05~10-14，30 分钟粒度）；"
        "主口径仅用 quality=ok 桶（missing 桶 %.2f%%、stale 桶 %.2f%% 单列覆盖率，不进分子分母）；"
        "data_source=synthetic"
        % (coverage["missing_ratio"] * 100, coverage["stale_ratio"] * 100)
    )
    return {
        "mae_spaces": main["mae_spaces"],
        "mae_ratio": main["mae_ratio"],
        "mae_pp": main["mae_pp"],
        "value": main["mae_ratio"],
        "unit": "ratio",
        "n": main["n"],
        "n_excluded": main["n_excluded"],
        "mean_total_spaces": sum(totals) / len(totals) if totals else None,
        "coverage": coverage,
        "per_lot": per_lot,
        "aux": {
            "hit_rate": hit["value"],
            "wape": wape["value"],
            "mape": mape["value"],
            "mape_excluded_ratio": mape["excluded_ratio"],
            "rmse": rmse["value"],
        },
        "note": note,
    }


def _parking_metric(which: str) -> Dict[str, Any]:
    metrics = parking_mae_metrics()
    value = metrics.get(which)
    unit = {"mae_ratio": "ratio", "mae_spaces": "spaces", "mae_pp": "pp"}[which]
    note = metrics["note"]
    if which == "mae_ratio":
        mean_total = metrics.get("mean_total_spaces")
        note += (
            "；主口径 MAE_ratio=Σ|e|/Σtotal_spaces=%.6f"
            % (metrics["mae_ratio"],)
        )
        if mean_total:
            note += "（等价 mae_spaces/mean(total_spaces)=%.6f）" % (
                metrics["mae_spaces"] / mean_total
            )
    per_lot_txt = "；".join(
        "%s ratio=%.4f (n=%d)" % (lot, data["mae_ratio"], data["n"])
        for lot, data in sorted(metrics.get("per_lot", {}).items())
    )
    if per_lot_txt:
        note += "；分车场：" + per_lot_txt
    return {
        "value": value,
        "unit": unit,
        "n": metrics["n"],
        "status": "computed",
        "coverage": metrics["coverage"],
        "per_lot": metrics.get("per_lot", {}),
        "aux": metrics.get("aux", {}),
        "note": note,
    }


def route_adoption_rate_metric() -> Dict[str, Any]:
    """路线采纳率（验收主口径·人数）：完成人数 ÷ 获得推荐人数。"""
    events = load_visitor_events()
    result = compute.compute_adoption_rate(
        events,
        "view_route",
        "finish_route",
        dedup_key="visitor_id",
        window_minutes=ROUTE_WINDOW_MINUTES,
        match_field="route_id",
    )
    result["note"] = (
        "完成人数/获得推荐人数（finish_route ÷ view_route），"
        "访客去重、%d 分钟观察窗口、route_id 匹配；data_source=synthetic"
        % ROUTE_WINDOW_MINUTES
    ) + "；" + result.get("note", "")
    return result


def route_adoption_offline_metric() -> Dict[str, Any]:
    """路线采纳率（离线代理·曝光人次）：adopted 曝光 ÷ 曝光总数。"""
    impressions = load_route_impressions()
    denominator = len(impressions)
    numerator = sum(1 for r in impressions if r.get("adopted") == "1")
    value = (numerator / denominator) if denominator else None
    return {
        "value": value,
        "numerator": numerator,
        "denominator": denominator,
        "unit": "ratio",
        "n": denominator,
        "status": "computed",
        "note": (
            "曝光明细表 adopted 占比（impression_id 去重）；"
            "为离线代理指标，不作为对外验收结论；data_source=synthetic"
        ),
    }


def parking_offpeak_adoption_metric() -> Dict[str, Any]:
    """错峰建议采纳率：采纳次数 ÷ 含错峰建议的展示次数。"""
    events = load_visitor_events()
    result = compute.compute_adoption_rate(
        events,
        "view_parking",
        "adopt_parking",
        dedup_key=None,  # 曝光次数口径
    )
    result["note"] = (
        "采纳次数 ÷ 含错峰建议的停车卡片展示次数（事件人次，不去重访客）；"
        "合成集中每次 view_parking 均带错峰建议；data_source=synthetic"
    ) + "；" + result.get("note", "")
    return result


def register_adapters() -> Dict[str, Any]:
    """把离线评测实现挂到注册表上（**不覆盖**已经注册好的实现）。

    框架自带的离线实现是**兜底**：归属包交付后用 ``registry.register_pack_metrics``
    注册自己的实现，而 runner 每轮都会重新 bootstrap 一遍；若这里直接覆盖，
    归属包（以及单测里替换实现来验证异常处理）的实现会被悄悄顶掉，
    指标就会算出「看起来正常」的值，异常路径根本走不到。
    """
    registry.register_impl(
        "parking_mae_ratio_1h", lambda: _parking_metric("mae_ratio"), override=False
    )
    registry.register_impl(
        "parking_mae_spaces_1h", lambda: _parking_metric("mae_spaces"), override=False
    )
    registry.register_impl(
        "parking_mae_pp_1h", lambda: _parking_metric("mae_pp"), override=False
    )
    registry.register_impl(
        "route_adoption_rate", route_adoption_rate_metric, override=False
    )
    registry.register_impl(
        "route_adoption_rate_offline", route_adoption_offline_metric, override=False
    )
    registry.register_impl(
        "parking_offpeak_adoption_rate", parking_offpeak_adoption_metric, override=False
    )
    return {"registered": True}


if __name__ == "__main__":  # pragma: no cover - 手动调试用
    import json

    register_adapters()
    print(json.dumps(parking_mae_metrics(), ensure_ascii=False, indent=2))
