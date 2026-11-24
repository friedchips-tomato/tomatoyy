"""通用指标计算函数（algo-metrics / 任务 M4）。

口径依据：本包 ``docs/metrics-definition.md``（指标口径定义书）。本模块只放**与业务无关的
通用算子**：采纳率、点击率、MAE、MAPE、RMSE、WAPE、命中率、时延、确认时长、可用率。
业务口径（事件对、去重规则、观察窗口、剔除规则）由 ``registry.py`` 里的指标条目声明，
由 ``adapters.py`` 调用本模块算子得到数值。

统一返回结构（所有函数）::

    {
      "value": float | None,   # 主口径数值；无法计算时为 None（绝不编造数字）
      "unit": str | None,       # "ratio" | "spaces" | "pp" | "ms" | "minutes" | ...
      "n": int,                # 实际参与计算的样本量
      "note": str,             # 口径说明 / 边界情况说明（分母为 0、空样本等）
      ...                      # 各函数自己的附加字段（numerator/denominator/mae_spaces...）
    }

边界约定（全局统一）：

* 样本为空 → ``value=None``，``note`` 说明「空样本」。
* 分母为 0 → ``value=None``，``note`` 说明「分母为 0」。
* 被剔除的样本（缺值、取消单、缺失桶）不计入分母，并在 ``note`` / ``n_excluded`` 里披露剔除量。
* 任何指标都必须能回答「分子是什么、分母是什么、样本从哪来」，否则不放进 ``registry.py``。
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

__all__ = [
    "compute_adoption_rate",
    "compute_click_rate",
    "compute_mae",
    "compute_mape",
    "compute_rmse",
    "compute_wape",
    "compute_hit_rate",
    "compute_latency_ms",
    "compute_duration_minutes",
    "compute_availability",
]

Result = Dict[str, Any]

# --------------------------------------------------------------------------------------
# 内部工具
# --------------------------------------------------------------------------------------


def _to_float(value: Any) -> Optional[float]:
    """把输入转成 float；None / 空串 / NaN / 非法值统一返回 None（表示缺值）。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    else:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _clean_pairs(
    y_true: Sequence[Any], y_pred: Sequence[Any]
) -> Tuple[List[Tuple[float, float]], int]:
    """按位对齐 (真值, 预测)，剔除任一侧缺值的样本，返回 (有效对, 被剔除数)。"""
    true_list = list(y_true)
    pred_list = list(y_pred)
    if len(true_list) != len(pred_list):
        raise ValueError(
            "y_true 与 y_pred 长度不一致：%d vs %d" % (len(true_list), len(pred_list))
        )
    pairs: List[Tuple[float, float]] = []
    excluded = 0
    for raw_true, raw_pred in zip(true_list, pred_list):
        actual = _to_float(raw_true)
        predicted = _to_float(raw_pred)
        if actual is None or predicted is None:
            excluded += 1
            continue
        pairs.append((actual, predicted))
    return pairs, excluded


def _total_list(total_spaces: Any, n: int) -> Optional[List[float]]:
    """把 total_spaces 统一成逐样本列表；None 表示没有容量信息。"""
    if total_spaces is None:
        return None
    if isinstance(total_spaces, (int, float)) and not isinstance(total_spaces, bool):
        value = _to_float(total_spaces)
        if value is None or value <= 0:
            return None
        return [value] * n
    values: List[float] = []
    for item in list(total_spaces)[:n]:
        value = _to_float(item)
        if value is None or value <= 0:
            return None
        values.append(value)
    if len(values) != n:
        return None
    return values


def _group_key(
    record: Dict[str, Any], dedup_key: Any
) -> Optional[Tuple[Any, ...]]:
    """按去重键取出分组标识；键缺失时返回 None（该样本不参与分组计数）。"""
    if dedup_key is None:
        return None
    if callable(dedup_key):
        key = dedup_key(record)
        return (key,) if key is not None else None
    if isinstance(dedup_key, str):
        fields: Tuple[str, ...] = (dedup_key,)
    else:
        fields = tuple(dedup_key)
    values: List[Any] = []
    for field in fields:
        if field not in record:
            return None
        values.append(record[field])
    return tuple(values)


def _parse_ts(value: Any) -> Optional[datetime]:
    """解析 ISO 8601 时间串（带或不带时区偏移均可）。解析失败返回 None。"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value))
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def _pick(record: Dict[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return None


def _percentile(sorted_values: Sequence[float], q: float) -> Optional[float]:
    """线性插值分位数（与 numpy.percentile 默认 linear 一致）。"""
    n = len(sorted_values)
    if n == 0:
        return None
    if n == 1:
        return float(sorted_values[0])
    position = (q / 100.0) * (n - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return float(sorted_values[int(position)])
    weight = position - lower
    return float(sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight)


# --------------------------------------------------------------------------------------
# 采纳率 / 点击率
# --------------------------------------------------------------------------------------


def _rate(
    events: Sequence[Dict[str, Any]],
    view_event: str,
    action_event: str,
    *,
    dedup_key: Any,
    window_minutes: Optional[float],
    match_field: Optional[str],
    label: str,
) -> Result:
    """采纳率 / 点击率的共用实现。

    分子分母（默认按访客去重）：

    * 分母 = 出现过 ``view_event`` 的去重分组数（"多少人/多少次看到了"）。
    * 分子 = 在这些分组里出现过 ``action_event``（且满足观察窗口、字段匹配约束）的去重分组数。

    ``window_minutes``：动作必须发生在该访客的展示事件之后、且间隔不超过该分钟数；
    ``match_field``：动作的该字段值必须落在同一访客展示事件的同字段取值集合内
    （例如路线采纳要求 finish_route 的 route_id 属于该访客看过的路线）。
    """
    records = [e for e in events if isinstance(e, dict) and "event_type" in e]
    views = [e for e in records if e["event_type"] == view_event]
    actions = [e for e in records if e["event_type"] == action_event]

    if not views:
        note = "空样本：没有 %s 事件，%s 无分母" % (view_event, label)
        return {
            "value": None,
            "numerator": 0,
            "denominator": 0,
            "unit": "ratio",
            "n": 0,
            "note": note,
        }

    # 上下文分组（用于观察窗口 / 字段匹配）：优先按 visitor_id，没有则按事件本身
    has_visitor = all("visitor_id" in r for r in views + actions)
    context_key = "visitor_id" if has_visitor else None

    def context_of(record: Dict[str, Any]) -> Any:
        if context_key is None:
            return id(record)
        return record.get(context_key)

    # 每个上下文分组的「最早展示时间」与「可匹配的字段取值集合」
    context_time: Dict[Any, Optional[datetime]] = {}
    context_values: Dict[Any, set] = {}
    for record in views:
        bucket = context_of(record)
        if bucket not in context_time:
            context_time[bucket] = None
        times = [t for t in (_parse_ts(r.get("ts")) for r in views
                             if context_of(r) == bucket) if t is not None]
        context_time[bucket] = min(times) if times else None
        if match_field:
            context_values[bucket] = {
                r.get(match_field) for r in views
                if context_of(r) == bucket and r.get(match_field) is not None
            }

    excluded_out_of_window = 0
    excluded_field_mismatch = 0
    hit_actions: List[Dict[str, Any]] = []
    for record in actions:
        bucket = context_of(record)
        if match_field:
            value = record.get(match_field)
            allowed = context_values.get(bucket, set())
            if value is None or value not in allowed:
                excluded_field_mismatch += 1
                continue
        if window_minutes is not None:
            base = context_time.get(bucket)
            action_ts = _parse_ts(record.get("ts"))
            if base is not None and action_ts is not None:
                delta = (action_ts - base).total_seconds() / 60.0
                if delta < 0 or delta > window_minutes:
                    excluded_out_of_window += 1
                    continue
        hit_actions.append(record)

    notes: List[str] = []
    if dedup_key is None:
        # 事件人次口径：分子=合格动作事件数，分母=展示事件数
        denominator = len(views)
        numerator = len(hit_actions)
        notes.append("未按访客去重，分子分母均为事件人次")
    else:
        view_groups: Dict[Any, List[Dict[str, Any]]] = {}
        for record in views:
            key = _group_key(record, dedup_key)
            bucket = "__raw__" if key is None else key
            view_groups.setdefault(bucket, []).append(record)
        hit_groups = set()
        for record in hit_actions:
            key = _group_key(record, dedup_key)
            bucket = "__raw__" if key is None else key
            if bucket in view_groups:
                hit_groups.add(bucket)
        denominator = len(view_groups)
        numerator = len(hit_groups)
        notes.append("分子分母均按 %s 去重后的分组数统计" % (dedup_key,))

    value = (numerator / denominator) if denominator else None
    if window_minutes is not None:
        notes.append("观察窗口 %g 分钟" % window_minutes)
    if match_field:
        notes.append("动作需匹配 %s" % match_field)
    if excluded_out_of_window:
        notes.append("窗口外动作剔除 %d 条" % excluded_out_of_window)
    if excluded_field_mismatch:
        notes.append("字段不匹配动作剔除 %d 条" % excluded_field_mismatch)

    return {
        "value": value,
        "numerator": numerator,
        "denominator": denominator,
        "unit": "ratio",
        "n": denominator,
        "n_events_view": len(views),
        "n_events_action": len(actions),
        "note": "；".join(notes),
    }


def compute_adoption_rate(
    events: Sequence[Dict[str, Any]],
    view_event: str,
    adopt_event: str,
    *,
    dedup_key: Any = "visitor_id",
    window_minutes: Optional[float] = None,
    match_field: Optional[str] = None,
) -> Result:
    """采纳率。

    :param events: 事件列表，每条至少含 ``event_type``；推荐同时带 ``visitor_id`` / ``ts``。
    :param view_event: 展示/获得推荐的事件类型（分母来源）。
    :param adopt_event: 采纳事件类型（分子来源）。
    :param dedup_key: 去重键，``"visitor_id"`` / ``("visitor_id", "route_id")`` / 可调用对象；
        ``None`` 表示按事件人次计数。
    :param window_minutes: 观察窗口（分钟），``None`` 表示不限。
    :param match_field: 需要在展示与采纳之间保持一致的字段（如 ``route_id``）。
    :return: ``{"value", "numerator", "denominator", "unit", "n", "note", ...}``
    """
    return _rate(
        events,
        view_event,
        adopt_event,
        dedup_key=dedup_key,
        window_minutes=window_minutes,
        match_field=match_field,
        label="采纳率",
    )


def compute_click_rate(
    events: Sequence[Dict[str, Any]],
    view_event: str,
    click_event: str,
    *,
    dedup_key: Any = "impression_id",
    window_minutes: Optional[float] = None,
    match_field: Optional[str] = None,
) -> Result:
    """点击率（曝光 → 点击）。

    与 :func:`compute_adoption_rate` 同结构，只是语义与默认去重键不同：
    默认按 ``impression_id`` 去重（同一曝光多次点击只算一次）。
    """
    return _rate(
        events,
        view_event,
        click_event,
        dedup_key=dedup_key,
        window_minutes=window_minutes,
        match_field=match_field,
        label="点击率",
    )


# --------------------------------------------------------------------------------------
# 预测误差类指标
# --------------------------------------------------------------------------------------


def compute_mae(
    y_true: Sequence[Any],
    y_pred: Sequence[Any],
    total_spaces: Any = None,
) -> Result:
    """平均绝对误差（MAE），一次返回三种口径。

    * ``mae_spaces`` = ``mean(|pred - actual|)``，单位 **车位**。
    * ``mae_ratio`` = ``sum(|pred - actual|) / sum(total_spaces)``，单位 **比例**（主口径）。
      单车场时等价于任务书写法 ``mean(|pred - actual|) / total_spaces``；
      多车场时为「按车位容量加权」的汇总口径（等价于 ``mae_spaces / mean(total_spaces)``）。
    * ``mae_pp`` = ``mean(|pred/total - actual/total|) * 100``，单位 **百分点**（空置率口径）。

    换算关系：``mae_ratio = mae_spaces / total_spaces``（单车场）；``mae_pp = mae_ratio * 100``
    仅在单车场（容量恒定）时成立，多车场时两者分母不同、不可混用。

    :param total_spaces: 车位总数；标量或逐样本序列；``None`` 表示只出车位数口径。
    """
    pairs, excluded = _clean_pairs(y_true, y_pred)
    n = len(pairs)
    result: Result = {
        "value": None,
        "unit": None,
        "n": n,
        "n_excluded": excluded,
        "mae_spaces": None,
        "mae_ratio": None,
        "mae_pp": None,
        "caliber": None,
        "note": "",
    }
    if n == 0:
        result["note"] = "空样本：无有效（真值, 预测）对"
        return result

    abs_errs = [abs(actual - predicted) for actual, predicted in pairs]
    mae_spaces = sum(abs_errs) / n
    result["mae_spaces"] = mae_spaces

    totals = _total_list(total_spaces, n)
    if totals is not None:
        pooled = sum(abs_errs) / sum(totals)
        result["mae_ratio"] = pooled
        result["mae_pp"] = sum(err / total for err, total in zip(abs_errs, totals)) / n * 100.0
        result["value"] = pooled
        result["unit"] = "ratio"
        result["caliber"] = "mae_ratio"
        result["note"] = (
            "主口径 mae_ratio=sum|e|/sum(total_spaces)=%.6f（=mae_spaces/mean(total_spaces)=%.6f）；"
            "并列口径 mae_spaces=%.4f 车位、mae_pp=%.4f 个百分点"
            % (pooled, mae_spaces / (sum(totals) / n), mae_spaces, result["mae_pp"])
        )
    else:
        result["value"] = mae_spaces
        result["unit"] = "spaces"
        result["caliber"] = "mae_spaces"
        result["note"] = "未提供 total_spaces，只出车位数口径 mae_spaces=%.4f" % mae_spaces

    if excluded:
        result["note"] += "；剔除缺值样本 %d 条" % excluded
    return result


def compute_mape(y_true: Sequence[Any], y_pred: Sequence[Any]) -> Result:
    """平均绝对百分比误差（MAPE）。

    ``mean(|pred - actual| / actual)``，**只在 ``actual > 0`` 上计算**；
    ``actual == 0``（满位）时 MAPE 无定义，必须剔除并披露剔除比例（与 parking-forecast
    的 ``mape`` / ``mape_excluded_ratio`` 同口径）。
    """
    pairs, excluded = _clean_pairs(y_true, y_pred)
    n = len(pairs)
    if n == 0:
        return {
            "value": None,
            "unit": "ratio",
            "n": 0,
            "n_used": 0,
            "excluded_ratio": None,
            "note": "空样本：无有效（真值, 预测）对",
        }
    positive = [(a, p) for a, p in pairs if a > 0]
    n_used = len(positive)
    excluded_ratio = 1.0 - (n_used / n)
    if n_used == 0:
        return {
            "value": None,
            "unit": "ratio",
            "n": n,
            "n_used": 0,
            "excluded_ratio": excluded_ratio,
            "note": "真值全为 0（满位），MAPE 无定义，全部剔除",
        }
    value = sum(abs(p - a) / a for a, p in positive) / n_used
    return {
        "value": value,
        "unit": "ratio",
        "n": n,
        "n_used": n_used,
        "excluded_ratio": excluded_ratio,
        "note": "仅在 actual>0 上计算，剔除 %d 条（%.2f%%）" % (n - n_used, excluded_ratio * 100),
    }


def compute_rmse(y_true: Sequence[Any], y_pred: Sequence[Any]) -> Result:
    """均方根误差（RMSE），对大误差更敏感。"""
    pairs, excluded = _clean_pairs(y_true, y_pred)
    n = len(pairs)
    if n == 0:
        return {
            "value": None,
            "unit": "spaces",
            "n": 0,
            "note": "空样本：无有效（真值, 预测）对",
        }
    value = math.sqrt(sum((p - a) ** 2 for a, p in pairs) / n)
    return {
        "value": value,
        "unit": "spaces",
        "n": n,
        "n_excluded": excluded,
        "note": "sqrt(mean((pred-actual)^2))，单位车位",
    }


def compute_wape(
    y_true: Sequence[Any], y_pred: Sequence[Any], weights: Optional[Sequence[Any]] = None
) -> Result:
    """加权绝对百分比误差（WAPE）。

    ``sum(w_i * |pred_i - actual_i|) / sum(w_i * actual_i)``；``weights`` 缺省等权（权重全 1），
    此时即为 ``sum|e| / sum(actual)``（口径 D，parking-forecast 的 ``wape`` 字段）。

    与 MAPE 的区别：MAPE 是「先算比再平均」，WAPE 是「先汇总再相除」，
    满位（actual=0）样本不会让结果爆炸，因此 WAPE 是稳定的百分比口径。
    """
    pairs, excluded = _clean_pairs(y_true, y_pred)
    n = len(pairs)
    if n == 0:
        return {
            "value": None,
            "unit": "ratio",
            "n": 0,
            "note": "空样本：无有效（真值, 预测）对",
        }
    if weights is None:
        w = [1.0] * n
    else:
        w = [_to_float(x) for x in list(weights)[:n]]
        if len(w) != n or any(x is None or x < 0 for x in w):
            return {
                "value": None,
                "unit": "ratio",
                "n": n,
                "note": "weights 与样本数不一致或含非法权重",
            }
    numerator = sum(wi * abs(p - a) for wi, (a, p) in zip(w, pairs))
    denominator = sum(wi * a for wi, (a, _) in zip(w, pairs))
    if denominator <= 0:
        return {
            "value": None,
            "unit": "ratio",
            "n": n,
            "note": "分母为 0（sum(weights*actual)=0），WAPE 无定义",
        }
    value = numerator / denominator
    return {
        "value": value,
        "unit": "ratio",
        "n": n,
        "n_excluded": excluded,
        "numerator": numerator,
        "denominator": denominator,
        "note": "sum(w|e|)/sum(w*actual)",
    }


def compute_hit_rate(
    y_true: Sequence[Any], y_pred: Sequence[Any], threshold_spaces: float
) -> Result:
    """命中率：``|pred - actual| <= threshold_spaces`` 的样本占比。

    parking-forecast 的 ``hit_rate`` 用的是 ``|e| <= 1``（±1 个车位），本函数口径一致。
    """
    threshold = _to_float(threshold_spaces)
    if threshold is None or threshold < 0:
        return {
            "value": None,
            "numerator": 0,
            "denominator": 0,
            "unit": "ratio",
            "n": 0,
            "note": "threshold_spaces 非法",
        }
    pairs, excluded = _clean_pairs(y_true, y_pred)
    n = len(pairs)
    if n == 0:
        return {
            "value": None,
            "numerator": 0,
            "denominator": 0,
            "unit": "ratio",
            "n": 0,
            "note": "空样本：无有效（真值, 预测）对",
        }
    hits = sum(1 for a, p in pairs if abs(p - a) <= threshold)
    return {
        "value": hits / n,
        "numerator": hits,
        "denominator": n,
        "unit": "ratio",
        "n": n,
        "n_excluded": excluded,
        "threshold_spaces": threshold,
        "note": "|pred-actual| <= %g 个车位的样本占比" % threshold,
    }


# --------------------------------------------------------------------------------------
# 时延 / 时长 / 可用率
# --------------------------------------------------------------------------------------


def compute_latency_ms(samples: Sequence[Any]) -> Result:
    """时延统计（毫秒）：p50 / p95 / max / mean。

    ``samples`` 可以是数值列表，或字典列表（取 ``ms`` / ``latency_ms`` / ``duration_ms`` /
    ``elapsed_ms`` 之一）。

    分位数用线性插值（等价于 ``numpy.percentile`` 默认 ``linear``）。
    """
    values: List[float] = []
    for item in samples:
        if isinstance(item, dict):
            raw = _pick(item, ("ms", "latency_ms", "duration_ms", "elapsed_ms", "value"))
            number = _to_float(raw)
        else:
            number = _to_float(item)
        if number is None:
            continue
        if number < 0:
            continue
        values.append(number)
    n = len(values)
    if n == 0:
        return {
            "value": None,
            "unit": "ms",
            "n": 0,
            "p50": None,
            "p95": None,
            "max": None,
            "mean": None,
            "note": "空样本：无可用时延样本",
        }
    ordered = sorted(values)
    p50 = _percentile(ordered, 50)
    p95 = _percentile(ordered, 95)
    result: Result = {
        "value": p95,
        "unit": "ms",
        "n": n,
        "p50": p50,
        "p95": p95,
        "max": ordered[-1],
        "mean": statistics.fmean(values),
        "min": ordered[0],
        "note": "p50/p95 用线性插值分位数",
    }
    return result


def compute_duration_minutes(
    starts: Sequence[Any],
    ends: Sequence[Any],
    exclude_cancelled: bool = True,
    *,
    cancelled: Optional[Sequence[Any]] = None,
) -> Result:
    """时长统计（分钟）：平均时长 + p50 / p95 / max。

    ``starts`` / ``ends`` 支持三种写法：

    1. 时间序列（ISO 8601 字符串或 ``datetime``），两个序列等长；
    2. 字典序列，每条含 ``ts``（或 ``start``/``requested_at``）与 ``end``（或 ``ended_at``/
       ``confirmed_at``），此时 ``starts``/``ends`` 传同一份列表即可；
    3. 配合 ``cancelled`` 参数传入取消标记（布尔序列或状态字符串序列）。

    ``exclude_cancelled=True`` 时剔除取消单（口径见 ``docs/metrics-definition.md`` 预约确认时长）。
    """
    items = list(starts)
    end_items = list(ends)
    use_dict = bool(items) and isinstance(items[0], dict)
    if use_dict:
        if end_items and end_items is not items:
            end_items = list(end_items)
        else:
            end_items = items
    elif len(items) != len(end_items):
        return {
            "value": None,
            "unit": "minutes",
            "n": 0,
            "note": "starts 与 ends 长度不一致",
        }

    durations: List[float] = []
    cancelled_count = 0
    invalid = 0
    for index, item in enumerate(items):
        if use_dict:
            start_raw = _pick(item, ("ts", "start", "start_ts", "requested_at", "created_at"))
            end_raw = _pick(item, ("end", "end_ts", "ended_at", "confirmed_at", "decided_at"))
            flag = item.get("cancelled")
            if flag is None:
                flag = item.get("status") == "cancelled"
        else:
            start_raw = item
            end_raw = end_items[index]
            flag = None
            if cancelled is not None and index < len(list(cancelled)):
                flag = list(cancelled)[index]
        start = _parse_ts(start_raw)
        end = _parse_ts(end_raw)
        if start is None or end is None:
            invalid += 1
            continue
        is_cancelled = bool(flag)
        if is_cancelled:
            cancelled_count += 1
            if exclude_cancelled:
                continue
        minutes = (end - start).total_seconds() / 60.0
        durations.append(minutes)

    n = len(durations)
    if n == 0:
        note = "空样本：无可用时长"
        if cancelled_count:
            note += "（剔除取消单 %d 条）" % cancelled_count
        if invalid:
            note += "；时间无法解析 %d 条" % invalid
        return {
            "value": None,
            "unit": "minutes",
            "n": 0,
            "n_cancelled": cancelled_count,
            "n_invalid": invalid,
            "note": note,
        }
    ordered = sorted(durations)
    notes = ["单位分钟"]
    if exclude_cancelled:
        notes.append("已剔除取消单 %d 条" % cancelled_count)
    else:
        notes.append("含取消单 %d 条" % cancelled_count)
    if invalid:
        notes.append("时间无法解析 %d 条" % invalid)
    return {
        "value": statistics.fmean(durations),
        "unit": "minutes",
        "n": n,
        "mean": statistics.fmean(durations),
        "p50": _percentile(ordered, 50),
        "p95": _percentile(ordered, 95),
        "max": ordered[-1],
        "min": ordered[0],
        "n_cancelled": cancelled_count,
        "n_invalid": invalid,
        "note": "；".join(notes),
    }


def compute_availability(n_ok: int, n_total: int) -> Result:
    """可用率 = 成功数 / 总请求数。

    分母为 0 → ``value=None`` 并在 ``note`` 说明（不得返回 0 或 1 充数）。
    """
    try:
        ok = int(n_ok)
        total = int(n_total)
    except (TypeError, ValueError):
        return {
            "value": None,
            "numerator": None,
            "denominator": None,
            "unit": "ratio",
            "n": 0,
            "note": "n_ok / n_total 非法",
        }
    if total <= 0:
        return {
            "value": None,
            "numerator": ok,
            "denominator": total,
            "unit": "ratio",
            "n": 0,
            "note": "分母为 0：统计窗口内没有核心功能请求，可用率无定义",
        }
    if ok < 0 or ok > total:
        return {
            "value": None,
            "numerator": ok,
            "denominator": total,
            "unit": "ratio",
            "n": total,
            "note": "n_ok 超出 [0, n_total] 范围",
        }
    return {
        "value": ok / total,
        "numerator": ok,
        "denominator": total,
        "unit": "ratio",
        "n": total,
        "note": "成功请求数 / 核心功能请求总数",
    }
