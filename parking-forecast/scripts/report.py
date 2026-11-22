"""重新生成 artifacts/{model.json, metrics.json, manifest.json, report.md}（阶段 2 入口）。

用法：``PYTHONPATH=src python scripts/report.py``（在 parking-forecast/ 目录下）。

本脚本完全确定性：同一份合成数据 → 同一批产物（model.json 可逐字节复算）。
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from pf.dataset import DatasetConfig, load_observations  # noqa: E402
from pf.features import HORIZONS, compute_feature_stats, prepare  # noqa: E402
from pf.backtest import (  # noqa: E402
    TrainRange, check_split, compute_metrics, degrade_coverage, overall_metrics,
    stratify, time_split, walk_forward,
)
from pf import train as T  # noqa: E402
from pf.export import build_model_artifact, data_fingerprint, write_json, write_text  # noqa: E402
from pf.recommend import RANKING_CAPS, RANKING_WEIGHTS  # noqa: E402

DATA_DIR = ROOT / "data" / "synthetic"
ARTIFACT_DIR = ROOT / "artifacts"

BASELINE_KEYS = ["last_known", "same_slot_median", "same_weekday_mean"]
BASELINE_LABELS = {
    "last_known": "B1 last_known",
    "same_slot_median": "B2 same_slot_median",
    "same_weekday_mean": "B3 same_weekday_mean",
}

SYNTHETIC_DISCLAIMER = (
    "本结果基于合成数据（source=synthetic），仅证明管线可用，不代表模型精度。"
    "正式精度指标必须由真实历史数据与现场校验得出。"
)


def _as_baseline(preds, key):
    out = []
    for p in preds:
        q = copy.copy(p)
        q.point_free = p.baselines.get(key)
        out.append(q)
    return out


def _round_m(m):
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()}


def _leakage_self_check(dataset, split, stats, model, n=50):
    """03 §3.7#1/#2 的轻量自检：删除 issued_at 之后的观测，特征与预测不变。"""
    from pf import features as F
    from pf import train as T
    import random

    prepared = prepare(dataset)
    lot_ids = list(prepared.lots.keys())
    tss = prepared.obs_by_lot[lot_ids[0]][0]
    lo, hi = split.test_start, split.test_end
    rng = random.Random(0)
    step = timedelta(minutes=F.MINUTES_PER_SLOT)
    total = int((hi - lo).total_seconds() // (60 * F.MINUTES_PER_SLOT))
    checked = 0
    for _ in range(n):
        k = rng.randint(0, total)
        t = lo + step * k
        for lot_id in lot_ids:
            f_full = F.build_lot_features(dataset, lot_id, t, t, stats=stats)
            fc_full, _ = T.forecast_lot(dataset, model, lot_id, t, t, stats=stats)
            # 删除 t 之后的观测
            from pf.dataset import Dataset
            obs_trunc = [o for o in dataset.observations if F.parse_ts(o["ts"]) <= t]
            ds_trunc = Dataset(lots=dataset.lots, observations=obs_trunc, signals=dataset.signals)
            f_trunc = F.build_lot_features(ds_trunc, lot_id, t, t, stats=stats)
            fc_trunc, _ = T.forecast_lot(ds_trunc, model, lot_id, t, t, stats=stats)
            if f_full.vector() != f_trunc.vector():
                return False, "特征在未来观测删除后发生变化 @%s %s" % (lot_id, t)
            if [x["point_free"] for x in fc_full] != [x["point_free"] for x in fc_trunc]:
                return False, "预测在未来观测删除后发生变化 @%s %s" % (lot_id, t)
            checked += 1
    return True, "checked=%d 特征与预测在未来观测删除后逐位不变" % checked


def main() -> int:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

    ds = load_observations(DatasetConfig(source="synthetic", data_dir=str(DATA_DIR)))
    manifest = json.loads((DATA_DIR / "manifest.json").read_text(encoding="utf-8"))
    fingerprint = data_fingerprint(manifest)
    prepared = prepare(ds)
    lot_ids = list(prepared.lots.keys())
    min_ts = min(prepared.obs_by_lot[l][0][0] for l in lot_ids)
    max_ts = max(prepared.obs_by_lot[l][0][-1] for l in lot_ids)

    split = time_split(min_ts, max_ts)
    split_problems = check_split(split)

    # 最终模型：在 test_start 之前所有数据上训练（部署用）
    final_tr = TrainRange(min_ts, split.test_start - timedelta(seconds=1))
    final_stats = compute_feature_stats(ds, final_tr)
    final_model = T.train_linear_model(ds, final_tr, final_stats)

    # 主口径：walk-forward（测试期每日重训、逐 15 分钟步进）
    wf_preds, wf_counts = walk_forward(ds, split)

    # 降级覆盖（全时间轴 + D1/D4 构造场景）
    dg_preds, dg_counts = degrade_coverage(ds, split)

    # ---- 主口径：D0 模型 vs 三基线（在 D0 样本上同口径对比）----
    d0 = [p for p in wf_preds if p.method == "model"]
    model_overall = overall_metrics(d0)
    baseline_overall = {k: overall_metrics(_as_baseline(d0, k)) for k in BASELINE_KEYS}
    by_horizon = {}
    for h in HORIZONS:
        ps = [p for p in d0 if p.horizon == h]
        by_horizon[str(h)] = {
            "model": overall_metrics(ps),
            **{k: overall_metrics(_as_baseline(ps, k)) for k in BASELINE_KEYS},
        }

    strongest = min(BASELINE_KEYS, key=lambda k: baseline_overall[k]["mae"])
    model_beats_every_horizon = all(
        by_horizon[str(h)]["model"]["mae"] < by_horizon[str(h)][strongest]["mae"]
        for h in HORIZONS
    )
    rel_improve_pct = (baseline_overall[strongest]["mae"] - model_overall["mae"]) / baseline_overall[strongest]["mae"] * 100.0

    # ---- 六维分层（全部 walk-forward 预测，含降级）----
    strat = {
        "horizon": stratify(wf_preds, lambda p: p.horizon),
        "lot": stratify(wf_preds, lambda p: p.lot_id),
        "workday_weekend": stratify(wf_preds, lambda p: "workday" if p.is_workday else "weekend/holiday"),
        "weather": stratify(wf_preds, lambda p: p.weather or "missing"),
        "has_event": stratify(wf_preds, lambda p: "event" if p.has_event else "no_event"),
        "quality": stratify(wf_preds, lambda p: p.quality),
    }

    # ---- 降级每级指标 ----
    per_method = {}
    for m in ["model", "same_slot_baseline", "same_weekday_baseline", "last_known", "unavailable"]:
        ms = [p for p in dg_preds if p.method == m]
        per_method[m] = overall_metrics(ms)

    # ---- 泄漏自检 ----
    leak_ok, leak_msg = _leakage_self_check(ds, split, final_stats, final_model, n=50)

    # ---- 写产物 ----
    trained_at = manifest.get("generated_at") or "2026-04-15T00:00:00+08:00"
    model_artifact = build_model_artifact(
        final_model, ds.lots, trained_at, fingerprint, source="synthetic"
    )
    write_json(ARTIFACT_DIR / "model.json", model_artifact)

    metrics = {
        "source": "synthetic",
        "denominator": {
            "chosen": "wape (口径 D)",
            "reason": "WAPE 聚合稳定、不随拥挤程度爆炸，推荐作为主百分比口径（03 §3.5 口径 D）",
            "a_relative_mean_free": model_overall["pct_a"],
            "b_relative_total_spaces": model_overall["pct_b"],
            "c_rate_mae_pp": model_overall["pct_c"],
            "d_wape": model_overall["pct_d"],
        },
        "split": {
            "train": [split.train_start.isoformat(), split.train_end.isoformat()],
            "valid": [split.valid_start.isoformat(), split.valid_end.isoformat()],
            "test": [split.test_start.isoformat(), split.test_end.isoformat()],
            "embargo_hours": split.embargo_hours,
            "problems": split_problems,
        },
        "main_model": {
            "scope": "D0 模型（kind=linear，增量岭回归）在 D0 样本上与三基线同口径对比",
            "overall_model": _round_m(model_overall),
            "overall_baselines": {BASELINE_LABELS[k]: _round_m(baseline_overall[k]) for k in BASELINE_KEYS},
            "by_horizon": {h: {k: _round_m(v) for k, v in by_horizon[h].items()} for h in by_horizon},
            "strongest_baseline": BASELINE_LABELS[strongest],
            "model_beats_strongest_every_horizon": model_beats_every_horizon,
            "relative_improvement_pct": round(rel_improve_pct, 2),
        },
        "degrade_coverage": {
            "method_counts": dg_counts,
            "per_method_metrics": {m: _round_m(v) for m, v in per_method.items()},
        },
        "walk_forward_method_counts": wf_counts,
        "stratification": {
            dim: {k: _round_m(v) for k, v in groups.items()}
            for dim, groups in strat.items()
        },
        "mape_excluded_ratio": model_overall["mape_excluded_ratio"],
        "synthetic_disclaimer": SYNTHETIC_DISCLAIMER,
        "leakage_self_check": {"ok": leak_ok, "detail": leak_msg},
    }
    write_json(ARTIFACT_DIR / "metrics.json", metrics)

    write_json(ARTIFACT_DIR / "manifest.json", {
        "schema_version": "2.0.0",
        "source": "synthetic",
        "generated_at": trained_at,
        "model_version": final_model["version"],
        "model_kind": final_model["kind"],
        "data_fingerprint": fingerprint,
        "data_manifest": manifest,
        "ridge_alpha": T.RIDGE_ALPHA,
        "seed": manifest.get("seed"),
        "files": {
            "model.json": hashlib.sha256((ARTIFACT_DIR / "model.json").read_bytes()).hexdigest(),
            "metrics.json": hashlib.sha256((ARTIFACT_DIR / "metrics.json").read_bytes()).hexdigest(),
        },
    })

    write_text(ARTIFACT_DIR / "report.md", _render_report(
        model_overall, baseline_overall, by_horizon, strongest, rel_improve_pct,
        model_beats_every_horizon, dg_counts, per_method, strat, metrics, fingerprint,
    ))

    print("artifacts written to %s" % ARTIFACT_DIR)
    print("model kind=%s, strongest_baseline=%s, rel_improve=%.2f%%"
          % (final_model["kind"], strongest, rel_improve_pct))
    print("degrade coverage:", dg_counts)
    print("leakage self-check:", leak_ok, leak_msg)
    return 0


def _render_report(model_overall, baseline_overall, by_horizon, strongest, rel_improve,
                   beats, dg_counts, per_method, strat, metrics, fingerprint) -> str:
    L = []
    A = L.append
    A("# 停车预测 · 回测报告（阶段 2）")
    A("")
    A("> **口径声明（首页）**：本报告采用 **WAPE（口径 D）作为主百分比口径**，"
      "同时给出绝对车位 MAE。选择 WAPE 的原因：聚合稳定、不随「满位时段分母趋 0」而爆炸，"
      "是最稳健的百分比口径（03 §3.5 推荐）。四个候选口径（A/B/C/D）一并列出，"
      "在需求方书面确认前**不自称达标**。")
    A("")
    A("> **合成数据声明**：**本结果基于合成数据（`source=synthetic`），仅证明管线可用，"
      "不代表模型精度。正式精度指标必须由真实历史数据与现场校验得出。**")
    A("")
    A("## 0. 模型与数据")
    A("")
    A("- 模型：`kind=linear`（增量岭回归，M1），预测目标 = `target − free_known`，"
      "每 horizon 一个系数向量 + 显式标准化 + 残差分位数区间 p10/p90。")
    A("- 数据指纹：`%s`（`data/synthetic/manifest.json` 的 file_sha256）。" % fingerprint)
    A("- 切分：train %s → valid %s → test %s，切分点后各留 24h embargo。"
      % (metrics["split"]["train"][0][:10] + "~" + metrics["split"]["train"][1][:10],
         metrics["split"]["valid"][0][:10] + "~" + metrics["split"]["valid"][1][:10],
         metrics["split"]["test"][0][:10] + "~" + metrics["split"]["test"][1][:10]))
    A("")
    A("## 1. 主口径：模型 vs 基线（D0 样本，绝对车位 MAE + WAPE）")
    A("")
    A("| 方法 | MAE（车位） | RMSE | WAPE% | 空置率 MAE（pp） | Bias | 命中率 | n |")
    A("|---|---|---|---|---|---|---|---|")
    A("| 模型（D0） | %.2f | %.2f | %.2f | %.2f | %+.2f | %.2f | %d |"
      % (model_overall["mae"], model_overall["rmse"],
         (model_overall["wape"] or 0) * 100, model_overall["rate_mae_pp"],
         model_overall["bias"], model_overall["hit_rate"], model_overall["n"]))
    for k in ["last_known", "same_slot_median", "same_weekday_mean"]:
        m = baseline_overall[k]
        A("| %s | %.2f | %.2f | %.2f | %.2f | %+.2f | %.2f | %d |"
          % (BASELINE_LABELS[k], m["mae"], m["rmse"], (m["wape"] or 0) * 100,
             m["rate_mae_pp"], m["bias"], m["hit_rate"], m["n"]))
    A("")
    A("- 最强基线：**%s**（MAE %.2f）。模型相对其下降 **%.1f%%**。" % (BASELINE_LABELS[strongest], baseline_overall[strongest]["mae"], rel_improve))
    A("- 逐 horizon 无一层比最强基线更差：**%s**。" % ("是" if beats else "否"))
    A("")
    A("| horizon | 模型 MAE | %s MAE | 模型 WAPE%% |" % BASELINE_LABELS[strongest])
    A("|---|---|---|---|")
    for h in ["15", "30", "45", "60"]:
        m = by_horizon[h]["model"]; b = by_horizon[h][strongest]
        A("| %s | %.2f | %.2f | %.2f |" % (h, m["mae"], b["mae"], (m["wape"] or 0) * 100))
    A("")
    A("### ≤20% 四口径（供需求方书面确认）")
    A("")
    A("| 口径 | 公式 | 值 |")
    A("|---|---|---|")
    A("| A 相对平均余位 | MAE / mean(actual) | %.2f%% |" % (model_overall["pct_a"] or 0))
    A("| B 相对总车位 | MAE / mean(total_spaces) | %.2f%% |" % (model_overall["pct_b"] or 0))
    A("| C 空置率 MAE | mean(|pred_rate−actual_rate|)×100 | %.2f pp |" % (model_overall["pct_c"] or 0))
    A("| **D WAPE（采用）** | sum(|e|)/sum(actual) | **%.2f%%** |" % (model_overall["pct_d"] or 0))
    A("")
    A("MAPE 仅在 `actual>0` 上计算，排除比例 **%.1f%%**。" % ((model_overall["mape_excluded_ratio"] or 0) * 100))
    A("")
    A("## 2. 降级路径覆盖（D0–D4 每级都被触发）")
    A("")
    A("| method | 级别 | 触发次数 | MAE（车位） |")
    A("|---|---|---|---|")
    for m in ["model", "same_slot_baseline", "same_weekday_baseline", "last_known", "unavailable"]:
        A("| %s | %s | %d | %s |" % (m, {"model": "D0", "same_slot_baseline": "D1",
                                          "same_weekday_baseline": "D2", "last_known": "D3",
                                          "unavailable": "D4"}[m],
                                     dg_counts.get(m, 0),
                                     "%.2f" % per_method[m]["mae"] if per_method[m]["mae"] is not None else "—"))
    A("")
    A("> D4 时 `point_free=null`（不是 0）；D3 只复制最后已知值，不外推趋势；D1 由「移除天气信号」"
      "构造场景触发（合成数据天气信号完整，D1 不会自然出现）。")
    A("")
    A("## 3. 六维分层（绝对 MAE / WAPE%）")
    A("")
    for dim, label in [("horizon", "按 horizon"), ("lot", "按车场"),
                       ("workday_weekend", "按工作日/周末"), ("weather", "按天气"),
                       ("has_event", "按有无活动"), ("quality", "按数据质量")]:
        A("**%s**" % label)
        A("")
        A("| 层 | MAE | WAPE% | n |")
        A("|---|---|---|---|")
        for k in sorted(strat[dim]):
            m = strat[dim][k]
            A("| %s | %.2f | %.2f | %d |" % (k, m["mae"] or 0, (m["wape"] or 0) * 100, m["n"]))
        A("")
    A("## 4. 泄漏自检与约束")
    A("")
    A("- 泄漏自检：%s。" % ("通过（" + metrics["leakage_self_check"]["detail"] + "）" if metrics["leakage_self_check"]["ok"] else "失败"))
    A("- 切分 embargo 检查：%s。" % ("通过" if not metrics["split"]["problems"] else "违规 " + str(metrics["split"]["problems"])))
    A("- Python/JS 逐位一致性：由 `tests/test_consistency.py` + `node --test runtime/test/` 断言（500 条输入）。")
    A("")
    A("## 5. 限制")
    A("")
    A("- 合成数据仅 14 天，周期基线（B2/B3）历史样本极少，且被「示范节假日 / 夜市」污染，"
      "故基线偏弱；这是合成验收的已知限制。")
    A("- `total_time` 退化为「步行 + 固定驾车常数估计」（无路网数据）。")
    A("- `transfer` 一律 `feasible=false`（无接驳点数据）。")
    A("")
    return "\n".join(L)


if __name__ == "__main__":
    raise SystemExit(main())
