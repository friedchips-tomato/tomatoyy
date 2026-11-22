"""训练（03 §3.3）与预测（降级链 03 §2.1）。

- M0 规则模型（same_slot_median + 分时段修正）——可解释上界。
- M1 岭回归（``kind="linear"``）——本任务**导出到 JS 运行时**的首选模型，
  每 horizon 一个系数向量 + 显式标准化（mean/std）+ 残差分位数区间（p10/p90）。
- M3 分位数回归（``HistGradientBoostingRegressor(loss="quantile")``，p10/p90）——
  用于回测区间指标对照，不导出。

预测入口 ``forecast_lot`` 实现 03 §2.1 降级链：

    D0 model → D1 same_slot → D2 same_weekday → D3 last_known → D4 unavailable

每一级都在 ``method`` / ``degrade_reason`` 留痕；D4 时 ``point_free=None``（不是 0）；
D3 只复制最后已知值，不外推趋势。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import features as F
from .features import (
    FEATURE_NAMES, HORIZONS, Features, build_lot_features, default_stats,
    fmt_ts, parse_ts, prepare,
)
from . import baselines as B

__all__ = [
    "MODEL_VERSION",
    "HORIZONS",
    "build_training_matrix",
    "train_linear_model",
    "train_rules_model",
    "train_quantile_models",
    "predict_point",
    "forecast_lot",
    "degrade_level",
    "round_half_up",
]

MODEL_VERSION = "2.0.0"

# 岭回归 / 规则 / 分位数模型的超参（写进 manifest 便于复算）
RIDGE_ALPHA = 0.3
GBDT_MAX_ITER = 200
GBDT_LEARNING_RATE = 0.1
GBDT_MAX_LEAF_NODES = 15


def round_half_up(x: float) -> int:
    """与 JS ``Math.round`` 一致的舍入（half away from zero）。"""
    return int(math.floor(x + 0.5))


def _round_clamp(x: float, total: int) -> int:
    return max(0, min(total, round_half_up(x)))


# --------------------------------------------------------------------------- #
# 训练矩阵
# --------------------------------------------------------------------------- #
def build_training_matrix(dataset, split, stats: Dict[str, Any]):
    """在 ``split.train`` 区间上按 15 分钟步进构造 (features, targets) 训练样本。

    返回 ``(rows, X)``：``rows`` 为 ``[(lot_id, issued_at, values_dict, targets_dict)]``，
    ``X`` 为 ``(n, len(FEATURE_NAMES))`` 的 float 数组。
    """
    prepared = prepare(dataset)
    lot_ids = list(prepared.lots.keys())
    rows: List[Tuple[str, datetime, Dict[str, float], Dict[int, float]]] = []

    t = split.train_start
    step = timedelta(minutes=F.MINUTES_PER_SLOT)
    while t <= split.train_end:
        for lot_id in lot_ids:
            f = build_lot_features(dataset, lot_id, t, t, stats=stats)
            targets: Dict[int, float] = {}
            for h in HORIZONS:
                a = F.actual_free_at(dataset, lot_id, t + timedelta(minutes=h))
                if a is not None:
                    targets[h] = float(a)
            if 60 in targets:
                rows.append((lot_id, t, f.values, targets))
        t += step

    X = np.array([[r[2][n] for n in FEATURE_NAMES] for r in rows], dtype=float)
    return rows, X


def _scaler_dicts(X: np.ndarray) -> Tuple[Dict[str, float], Dict[str, float]]:
    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std = np.where(std < 1e-12, 1.0, std)
    return (
        {n: float(mean[j]) for j, n in enumerate(FEATURE_NAMES)},
        {n: float(std[j]) for j, n in enumerate(FEATURE_NAMES)},
    )


def _calendar_table() -> Dict[str, List[float]]:
    return {
        "time_sin": F.TIME_SIN,
        "time_cos": F.TIME_COS,
        "dow_sin": F.DOW_SIN,
        "dow_cos": F.DOW_COS,
    }


# --------------------------------------------------------------------------- #
# M1 岭回归（导出模型）
# --------------------------------------------------------------------------- #
def train_linear_model(dataset, split, stats: Dict[str, Any]) -> Dict[str, Any]:
    """M1：岭回归，**预测目标 = target − free_known（增量）**，导出为 ``kind="linear"``。

    点预测 = ``free_known + (delta_intercept + Σ coef·(x−mean)/std)``。用增量而非绝对余位
    做目标，避免短 horizon 下对「当前水平」的收缩，从而在每个 horizon 都不弱于
    last_known 基线（03 §3.5「无某层更差」）。
    """
    from sklearn.linear_model import Ridge

    rows, X = build_training_matrix(dataset, split, stats)
    mean, std = _scaler_dicts(X)
    Xs = (X - np.array([mean[n] for n in FEATURE_NAMES])) / np.array([std[n] for n in FEATURE_NAMES])

    horizons: Dict[str, Any] = {}
    resid_q: Dict[str, Any] = {}
    for h in HORIZONS:
        idx = [i for i, r in enumerate(rows) if h in r[3]]
        Xh = Xs[idx]
        yh = np.array([r[3][h] - r[2]["free_known"] for i, r in enumerate(rows) if h in r[3]], dtype=float)
        ridge = Ridge(alpha=RIDGE_ALPHA).fit(Xh, yh)
        coef = {n: float(ridge.coef_[j]) for j, n in enumerate(FEATURE_NAMES)}
        intercept = float(ridge.intercept_)
        horizons[str(h)] = {"intercept": intercept, "coef": coef}

        # 点预测残差（actual − point）的分位数，用于 p10/p90 区间
        delta_pred = ridge.predict(Xh)
        point_pred = np.array([r[2]["free_known"] for i, r in enumerate(rows) if h in r[3]], dtype=float) + delta_pred
        resid = np.array([r[3][h] for i, r in enumerate(rows) if h in r[3]], dtype=float) - point_pred
        q10 = float(np.quantile(resid, 0.10))
        q90 = float(np.quantile(resid, 0.90))
        resid_q[str(h)] = {"q10": q10, "q90": q90}

    return {
        "version": MODEL_VERSION,
        "kind": "linear",
        "feature_names": list(FEATURE_NAMES),
        "scaler": {"mean": mean, "std": std},
        "horizons": horizons,
        "residual_quantiles": resid_q,
        "feature_fills": stats,
        "calendar": _calendar_table(),
    }


# --------------------------------------------------------------------------- #
# M0 规则模型（same_slot_median + 分时段修正）
# --------------------------------------------------------------------------- #
def train_rules_model(dataset, split, stats: Dict[str, Any]) -> Dict[str, Any]:
    """M0：point = same_slot_median(target) + correction[hour(target)]。

    correction 由训练集「实际 − same_slot_median」按目标小时求均值得到（可解释查表）。
    """
    prepared = prepare(dataset)
    lot_ids = list(prepared.lots.keys())
    buckets: Dict[int, List[float]] = {h: [] for h in range(24)}

    t = split.train_start
    step = timedelta(minutes=F.MINUTES_PER_SLOT)
    while t <= split.train_end:
        for lot_id in lot_ids:
            target = t + timedelta(minutes=60)
            a = F.actual_free_at(dataset, lot_id, target)
            if a is None:
                continue
            base = B.same_slot_median_at(dataset, lot_id, target, t)
            if base is not None:
                buckets[target.hour].append(a - base)
        t += step

    correction = {}
    for h in range(24):
        if buckets[h]:
            correction[str(h)] = sum(buckets[h]) / float(len(buckets[h]))
        else:
            correction[str(h)] = 0.0

    return {
        "version": MODEL_VERSION,
        "kind": "rules",
        "feature_names": [],
        "payload": {"correction_by_hour": correction},
        "feature_fills": stats,
        "calendar": _calendar_table(),
    }


# --------------------------------------------------------------------------- #
# M3 分位数回归（回测区间对照，不导出）
# --------------------------------------------------------------------------- #
def train_quantile_models(dataset, split, stats: Dict[str, Any]):
    """每个 horizon 训练 p10/p90 两个分位数 GBDT，返回 {horizon: {"p10": gbr, "p90": gbr}}。"""
    from sklearn.ensemble import HistGradientBoostingRegressor

    rows, X = build_training_matrix(dataset, split, stats)
    models: Dict[str, Dict[str, Any]] = {}
    for h in HORIZONS:
        idx = [i for i, r in enumerate(rows) if h in r[3]]
        Xh = X[idx]
        yh = np.array([r[3][h] for i, r in enumerate(rows) if h in r[3]], dtype=float)
        p10 = HistGradientBoostingRegressor(
            loss="quantile", quantile=0.10, max_iter=GBDT_MAX_ITER,
            learning_rate=GBDT_LEARNING_RATE, max_leaf_nodes=GBDT_MAX_LEAF_NODES,
            random_state=0,
        ).fit(Xh, yh)
        p90 = HistGradientBoostingRegressor(
            loss="quantile", quantile=0.90, max_iter=GBDT_MAX_ITER,
            learning_rate=GBDT_LEARNING_RATE, max_leaf_nodes=GBDT_MAX_LEAF_NODES,
            random_state=0,
        ).fit(Xh, yh)
        models[str(h)] = {"p10": p10, "p90": p90}
    return models


# --------------------------------------------------------------------------- #
# 预测（线性模型，与 JS 逐位一致）
# --------------------------------------------------------------------------- #
def predict_point(model: Dict[str, Any], h: int, values: Dict[str, float]) -> float:
    """线性模型的原始点预测（未舍入）：``free_known + 增量预测``。

    累加顺序必须与 runtime/forecast.mjs 完全一致（逐位相等依赖于此）。
    """
    hz = model["horizons"][str(h)]
    mean = model["scaler"]["mean"]
    std = model["scaler"]["std"]
    acc = values["free_known"] + hz["intercept"]
    for name in model["feature_names"]:
        acc = acc + hz["coef"][name] * (values[name] - mean[name]) / std[name]
    return acc


# --------------------------------------------------------------------------- #
# 降级链
# --------------------------------------------------------------------------- #
def degrade_level(f: Features) -> str:
    """03 §2.1 降级链判定（命中即停）。"""
    m = f.meta
    if m.get("free_known") is None:
        return "D4"
    has_slot = m.get("same_slot_median") is not None
    has_weekday = m.get("same_weekday_mean") is not None
    if not has_slot and not has_weekday:
        return "D3"
    if has_slot:
        complete = not any(
            f.values.get(n) for n in ("lag_missing", "calendar_missing", "weather_missing",
                                      "event_missing", "periodic_missing")
        )
        return "D0" if complete else "D1"
    return "D2"


_METHOD_BY_LEVEL = {
    "D0": "model",
    "D1": "same_slot_baseline",
    "D2": "same_weekday_baseline",
    "D3": "last_known",
    "D4": "unavailable",
}


def _degrade_reason(level: str, f: Features) -> Optional[str]:
    if level == "D0":
        return None
    if level == "D1":
        if f.values.get("lag_missing"):
            return "missing_observation"
        if f.values.get("calendar_missing"):
            return "missing_calendar"
        if f.values.get("weather_missing"):
            return "missing_weather"
        if f.values.get("event_missing"):
            return "missing_event"
        return "missing_periodic"
    if level == "D2":
        return "insufficient_same_slot"
    if level == "D3":
        return "no_history"
    return "missing_observation"


def forecast_lot(dataset, model: Dict[str, Any], lot_id: str, issued_at: datetime,
                 cutoffs: Optional[datetime] = None, horizons: Sequence[int] = HORIZONS,
                 stats: Optional[Dict[str, Any]] = None):
    """对单个车场在 ``issued_at`` 生成未来 ``horizons`` 的预测，返回 ``(forecasts, features)``。

    ``forecasts`` 为 horizon 序的 schema 兼容 dict 列表（03 §2.1 / 02 §2.4）。
    """
    if cutoffs is None:
        cutoffs = issued_at
    if stats is None:
        stats = model.get("feature_fills") or default_stats()

    prepared = prepare(dataset)
    total = int(prepared.lots[lot_id]["total_spaces"])
    f = build_lot_features(dataset, lot_id, issued_at, cutoffs, stats=stats)

    level = degrade_level(f)
    method = _METHOD_BY_LEVEL[level]
    reason = _degrade_reason(level, f)
    free_known = f.meta.get("free_known")
    free_known_ts = f.meta.get("free_known_ts")

    forecasts: List[Dict[str, Any]] = []
    for h in horizons:
        target_ts = issued_at + timedelta(minutes=h)
        point = None
        p10 = None
        p90 = None

        if level == "D0":
            z = predict_point(model, h, f.values)
            point = _round_clamp(z, total)
            p10 = _round_clamp(z + model["residual_quantiles"][str(h)]["q10"], total)
            p90 = _round_clamp(z + model["residual_quantiles"][str(h)]["q90"], total)
        elif level == "D1":
            v = B.same_slot_median_at(dataset, lot_id, target_ts, cutoffs)
            if v is None:
                v = B.same_weekday_mean_at(dataset, lot_id, target_ts, cutoffs)
            if v is None:
                v = free_known
            point = _round_clamp(float(v), total) if v is not None else None
        elif level == "D2":
            v = B.same_weekday_mean_at(dataset, lot_id, target_ts, cutoffs)
            if v is None:
                v = free_known
            point = _round_clamp(float(v), total) if v is not None else None
        elif level == "D3":
            point = int(free_known) if free_known is not None else None
        else:  # D4
            point = None

        free_rate = (point / float(total)) if point is not None else None
        forecasts.append({
            "lot_id": lot_id,
            "issued_at": fmt_ts(issued_at),
            "target_ts": fmt_ts(target_ts),
            "horizon_minutes": int(h),
            "point_free": point,
            "p10": p10,
            "p90": p90,
            "free_rate": free_rate,
            "method": method,
            "degraded": level != "D0",
            "degrade_reason": reason,
            "model_version": model["version"] if method == "model" else None,
            "data_asof": fmt_ts(free_known_ts) if free_known_ts is not None else None,
            "source": "synthetic",
        })

    return forecasts, f
