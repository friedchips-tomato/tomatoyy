"""指标注册表（algo-metrics / 任务 M4）。

一个指标条目 = 「定义 + 口径 + 归属包 + 数据来源 + 计算函数」。
本模块只声明**口径与元数据**，不含业务实现；实现由三方注册：

* ``adapters.py``：本框架自带的离线评测实现（读 ``datasets/`` 里的合成评测集）。
* ``stubs.py``：尚未交付的包（route-recommender / kg-recommend / guide-match-profile /
  AI 讲解 / 性能 / 系统）的桩函数，返回 ``{"value": null, "status": "not_implemented"}``，
  **不编造数字**。
* 其它算法包交付后：调用 :func:`register_pack_metrics` 注册自己的实现
  （各包之间不互相 import，集成阶段由装配脚本统一注册）。

口径正文见 ``docs/metrics-definition.md``；每个条目带 ``doc_ref`` 指回对应小节。
"""

from __future__ import annotations

import copy
from typing import Any, Callable, Dict, List, Optional

__all__ = [
    "MetricSpec",
    "METRICS",
    "register_metric",
    "register_pack_metrics",
    "register_impl",
    "get_metric",
    "list_metrics",
    "filter_metrics",
    "evaluate_metric",
    "check_target",
]

FRAMEWORK_VERSION = "0.1.0"
CONTRACT_REF = "CONTRACT v1（含 §4.9 数据库视图契约与 §7 决策记录）"


class MetricSpec:
    """一条指标的口径声明。"""

    def __init__(
        self,
        name: str,
        title: str,
        pack: str,
        definition: str,
        formula: str,
        numerator: str,
        denominator: str,
        data_source: str,
        sample_requirement: str,
        boundary: str,
        example: str,
        *,
        unit: str,
        target_op: Optional[str] = None,
        target_value: Optional[float] = None,
        target_display: str = "—",
        direction: str = "higher_is_better",
        role: str = "primary",
        doc_ref: str = "",
        impl_key: Optional[str] = None,
        status_hint: str = "pack",
        evidence: str = "pack-provided",
        verified: bool = False,
        notes: str = "",
    ) -> None:
        self.name = name
        self.title = title
        self.pack = pack
        self.definition = definition
        self.formula = formula
        self.numerator = numerator
        self.denominator = denominator
        self.data_source = data_source
        self.sample_requirement = sample_requirement
        self.boundary = boundary
        self.example = example
        self.unit = unit
        self.target_op = target_op
        self.target_value = target_value
        self.target_display = target_display
        self.direction = direction
        self.role = role
        self.doc_ref = doc_ref
        self.impl_key = impl_key or name
        self.status_hint = status_hint  # builtin | pack | future
        self.evidence = evidence  # synthetic-offline | pack-provided
        # 数据是否已核验：合成数据一律 False；真实数据到位并核验后由归属包改写
        self.verified = verified
        self.notes = notes
        self.impl: Optional[Callable[[], Dict[str, Any]]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "title": self.title,
            "pack": self.pack,
            "definition": self.definition,
            "formula": self.formula,
            "numerator": self.numerator,
            "denominator": self.denominator,
            "data_source": self.data_source,
            "sample_requirement": self.sample_requirement,
            "boundary": self.boundary,
            "example": self.example,
            "unit": self.unit,
            "target_op": self.target_op,
            "target_value": self.target_value,
            "target_display": self.target_display,
            "direction": self.direction,
            "role": self.role,
            "doc_ref": self.doc_ref,
            "impl_key": self.impl_key,
            "status_hint": self.status_hint,
            "evidence": self.evidence,
            "verified": self.verified,
            "notes": self.notes,
        }

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return "<MetricSpec %s (%s)>" % (self.name, self.pack)


METRICS: Dict[str, MetricSpec] = {}


def register_metric(spec: MetricSpec) -> MetricSpec:
    """注册（或覆盖）一条指标声明。"""
    METRICS[spec.name] = spec
    return spec


def register_pack_metrics(pack: str, implementations: Dict[str, Callable[[], Dict[str, Any]]]) -> None:
    """供其它算法包注册自己的实现（并行开发期用桩，交付后替换）。

    :param pack: 包名，如 ``"route-recommender"``。
    :param implementations: ``{指标名: 计算函数}``；函数返回统一结构
        ``{"value", "unit", "n", "note", ...}``。
    """
    for name, impl in implementations.items():
        spec = METRICS.get(name)
        if spec is None:
            continue
        # 归属包注册的实现**覆盖**框架桩与离线适配器（这是交付后的替换路径）。
        register_impl(name, impl, override=True)
        spec.status_hint = "pack"
        spec.evidence = "pack-provided"


def register_impl(
    name: str, impl: Callable[[], Dict[str, Any]], *, override: bool = True
) -> None:
    """给已声明的指标挂上实现函数。

    :param name: 指标名。
    :param impl: 计算函数，返回统一结构 ``{"value", "unit", "n", "note", ...}``。
    :param override: ``True``（默认）直接覆盖已有实现；``False`` 时若该指标已经注册过实现
        则**保留原实现**。框架自带的离线适配器用 ``override=False``：
        它们只是兜底实现，不能把归属包（或测试）已经注册的实现顶掉。
    """
    spec = METRICS.get(name)
    if spec is None:
        raise KeyError("未声明的指标：%s" % name)
    if spec.impl is not None and not override:
        return
    spec.impl = impl


def get_metric(name: str) -> Optional[MetricSpec]:
    return METRICS.get(name)


def list_metrics() -> List[MetricSpec]:
    """按声明顺序返回全部指标。"""
    return list(METRICS.values())


def filter_metrics(
    only: Optional[List[str]] = None, pack: Optional[List[str]] = None
) -> List[MetricSpec]:
    """按指标名 / 归属包过滤。"""
    specs = list_metrics()
    if only:
        wanted = set(only)
        specs = [s for s in specs if s.name in wanted]
    if pack:
        wanted_packs = set(pack)
        specs = [s for s in specs if s.pack in wanted_packs]
    return specs


def check_target(spec: MetricSpec, value: Optional[float]) -> Optional[bool]:
    """按目标判定达标；``None`` 表示无法判定（无值，或该口径不单独判定）。"""
    if value is None or spec.target_value is None or spec.target_op is None:
        return None
    if spec.target_op == "<=":
        return value <= spec.target_value
    if spec.target_op == ">=":
        return value >= spec.target_value
    return None


def evaluate_metric(spec: MetricSpec) -> Dict[str, Any]:
    """执行一条指标的实现，返回统一结果结构（含状态、样本量、口径引用）。"""
    if spec.impl is None:
        return {
            "name": spec.name,
            "title": spec.title,
            "pack": spec.pack,
            "value": None,
            "unit": spec.unit,
            "status": "not_implemented",
            "target": spec.target_display,
            "target_op": spec.target_op,
            "target_value": spec.target_value,
            "passed": None,
            "n": 0,
            "note": "未注册实现函数（应由归属包或 adapters 注册）",
            "doc_ref": spec.doc_ref,
            "data_source": spec.data_source,
            "evidence": spec.evidence,
            "verified": spec.verified,
        }
    result = copy.deepcopy(spec.impl())
    result.setdefault("value", None)
    result.setdefault("unit", spec.unit)
    result.setdefault("n", 0)
    result.setdefault("note", "")
    result.setdefault("status", "computed")
    result.update(
        {
            "name": spec.name,
            "title": spec.title,
            "pack": spec.pack,
            "target": spec.target_display,
            "target_op": spec.target_op,
            "target_value": spec.target_value,
            "passed": check_target(spec, result.get("value")),
            "doc_ref": spec.doc_ref,
            "data_source": spec.data_source,
            "evidence": spec.evidence,
            "verified": spec.verified,
            "role": spec.role,
        }
    )
    return result


# --------------------------------------------------------------------------------------
# 指标清单（口径正文见 docs/metrics-definition.md）
# --------------------------------------------------------------------------------------

register_metric(
    MetricSpec(
        name="route_generation_latency_ms",
        title="路线生成时间（p95）",
        pack="route-recommender",
        definition=(
            "一次路线推荐请求从进入推荐服务到返回 3 条候选路线的端到端耗时。"
            "验收看 p95（不用平均值），并同时报 p50 与最大值。"
        ),
        formula="latency = t(响应返回) − t(请求进入)；统计 p50 / p95 / max",
        numerator="—（时延类指标，无分子分母）",
        denominator="—（样本量 = 有效请求数 n）",
        data_source=(
            "route-recommender 自测输出 route_result.json 的 generated_ms 字段"
            "（100 点位规模、duration_minutes=60、三条候选路线）"
        ),
        sample_requirement="≥ 100 次请求（同一份请求集重复采样，剔除冷启动首轮）",
        boundary=(
            "请求异常/超时的样本单独统计为失败率，不计入时延分位数；"
            "序列化（含 JSON 编码）计入耗时；模型加载等一次性初始化不计入单次请求"
        ),
        example="100 次请求：p50=820ms，p95=1930ms，max=2410ms → p95 ≤ 3000ms 达标",
        unit="ms",
        target_op="<=",
        target_value=3000.0,
        target_display="≤ 3000 ms（p95）",
        direction="lower_is_better",
        doc_ref="docs/metrics-definition.md#2-1-路线生成时间",
        status_hint="pack",
        evidence="pack-provided",
        notes="归属包交付后由 route-recommender 注册实现；本阶段为桩。",
    )
)

register_metric(
    MetricSpec(
        name="route_adoption_rate",
        title="路线采纳率（验收主口径·人数）",
        pack="route-recommender",
        definition=(
            "按需求书原文：分子=按推荐路线游览并完成的人数，分母=获得推荐路线的人数。"
            "完成以 finish_route 事件为准（不能用点击「出发」的人数替代）。"
        ),
        formula="rate = |{访客: 有 finish_route 且 route_id 属于其看过的路线}| ÷ |{访客: 有 view_route}|",
        numerator="去重访客数：在 view_route 后 24 小时观察窗口内、按被看过的 route_id 产生 finish_route 的访客",
        denominator="去重访客数：产生过 view_route（获得推荐路线）的访客",
        data_source=(
            "algo_visitor_events 视图（基表 visitor_events）"
            "event_type ∈ {view_route, finish_route}"
        ),
        sample_requirement="≥ 300 个获得推荐的访客；观察窗口 24 小时",
        boundary=(
            "无 view_route 的 finish_route 视为脏数据剔除；"
            "同一访客多次曝光只计 1 人；窗口外完成的样本剔除并披露数量"
        ),
        example="300 人获得推荐，其中 132 人完成 → 132/300 = 44.0% ≥ 40% 达标",
        unit="ratio",
        target_op=">=",
        target_value=0.40,
        target_display="≥ 40%",
        direction="higher_is_better",
        doc_ref="docs/metrics-definition.md#2-2-路线采纳率",
        status_hint="builtin",
        evidence="synthetic-offline",
        notes="本阶段用合成事件流验证计算链路；真实达标需真实埋点数据。",
    )
)

register_metric(
    MetricSpec(
        name="route_adoption_rate_offline",
        title="路线采纳率（离线代理·曝光人次）",
        pack="route-recommender",
        definition=(
            "离线代理指标：在曝光明细表上按「被采纳的曝光数 ÷ 曝光总数」计，"
            "用于算法包自测时快速回归，不作为对外验收结论。"
        ),
        formula="rate = Σ adopted(1) ÷ Σ 曝光条数（按 impression_id 去重）",
        numerator="adopted=1 的曝光条数",
        denominator="曝光明细表总条数（impression_id 去重）",
        data_source="route_impressions_sample.csv（合成评测集，含 adopted 0/1）",
        sample_requirement="≥ 200 条曝光",
        boundary="重复上报的同一 impression_id 只计一次；aborted 的曝光应剔除（合成集不含该状态）",
        example="240 条曝光、108 条 adopted → 45.0%",
        unit="ratio",
        target_op=">=",
        target_value=0.40,
        target_display="≥ 40%（离线代理）",
        direction="higher_is_better",
        role="auxiliary",
        doc_ref="docs/metrics-definition.md#2-2-路线采纳率",
        status_hint="builtin",
        evidence="synthetic-offline",
        notes="辅助口径，仅作回归监控；对外验收用 route_adoption_rate。",
    )
)

register_metric(
    MetricSpec(
        name="kg_recommendation_ctr",
        title="语义关联推荐点击率",
        pack="kg-recommend",
        definition=(
            "知识图谱语义关联推荐（故事线/关联点位卡片）的曝光→点击转化率。"
            "曝光=推荐卡片被渲染且可见；点击=用户点击卡片进入详情。"
        ),
        formula="ctr = 去重后的点击曝光数 ÷ 去重后的曝光数",
        numerator="点击事件数（按 impression_id 去重，同一曝光多次点击只算一次）",
        denominator="曝光事件数（按 impression_id 去重）",
        data_source=(
            "kg-recommend 包的曝光/点击埋点；"
            "视图 algo_visitor_events 需补 KG 曝光/点击事件类型（TODO：契约增补，负责人=算法负责人）"
        ),
        sample_requirement="≥ 500 条曝光，覆盖工作日/周末与节假日",
        boundary=(
            "曝光未渲染完成（首帧外）不计曝光；点击事件必须能关联到 impression_id；"
            "同一曝光 30 分钟内的多次点击只算一次"
        ),
        example="800 条曝光、216 条点击 → 27.0% ≥ 25% 达标",
        unit="ratio",
        target_op=">=",
        target_value=0.25,
        target_display="≥ 25%",
        direction="higher_is_better",
        doc_ref="docs/metrics-definition.md#2-3-语义关联推荐点击率",
        status_hint="pack",
        evidence="pack-provided",
        notes="kg-recommend 包交付后注册实现；本阶段为桩。",
    )
)

register_metric(
    MetricSpec(
        name="voice_naturalness_mos",
        title="语音自然度 MOS",
        pack="ai-narration",
        definition=(
            "AI 讲解语音的听感主观评分（Mean Opinion Score），1–5 分。"
            "采用 ITU-T P.808 风格的 5 级主观听测问卷。"
        ),
        formula="MOS = Σ 单个评分 ÷ 有效问卷数（每份问卷取 3 个题项的均值后再汇总）",
        numerator="Σ 每份问卷的自然度得分（3 题均值）",
        denominator="有效问卷数（通过注意力检测与听音完整度校验的问卷）",
        data_source="MOS 问卷与评分表（人工听测，尚未交付）",
        sample_requirement=(
            "≥ 30 份有效问卷、覆盖 ≥ 3 个语种（普通话/粤语/外语）与 ≥ 2 类内容主题；"
            "同一评分员最多计入 3 份"
        ),
        boundary=(
            "无效问卷（未听完、注意力检测失败、重复提交）剔除并披露数量；"
            "同一音频被多人评分时按评分员去重后取中位数再参与平均"
        ),
        example="32 份有效问卷，题目均值 3.86、3.78、3.95 → MOS = 3.86 ≥ 3.8 达标",
        unit="score",
        target_op=">=",
        target_value=3.8,
        target_display="≥ 3.8 / 5",
        direction="higher_is_better",
        doc_ref="docs/metrics-definition.md#2-4-语音自然度-mos",
        status_hint="future",
        evidence="pack-provided",
        notes="AI 讲解包后续交付；本阶段只给问卷设计与聚合口径。",
    )
)

register_metric(
    MetricSpec(
        name="guide_point_match_accuracy",
        title="讲解点位匹配准确率",
        pack="ai-narration",
        definition=(
            "AI 讲解在用户所在点位播报的内容，与该点位实际讲解内容一致的比例（人工抽检）。"
        ),
        formula="accuracy = 匹配正确的讲解条数 ÷ 抽检讲解条数",
        numerator="判定为「点位匹配正确」的讲解条数",
        denominator="抽检的讲解条数（每条 = 一次讲解播放）",
        data_source="讲解抽检标注集（标注表尚未交付）",
        sample_requirement="≥ 200 条抽检讲解，覆盖全部在营点位与 ≥ 3 类内容主题",
        boundary=(
            "判定规则：播放点位的 point_id 与讲解内容的 point_id 一致且内容主题匹配 → 正确；"
            "点位错配、内容错配、无法判定分别计数并披露；「无法判定」不计入分母但必须单列"
        ),
        example="抽检 220 条，正确 205 条 → 93.2% ≥ 90% 达标",
        unit="ratio",
        target_op=">=",
        target_value=0.90,
        target_display="≥ 90%",
        direction="higher_is_better",
        doc_ref="docs/metrics-definition.md#2-5-讲解点位匹配准确率",
        status_hint="future",
        evidence="pack-provided",
        notes="AI 讲解包后续交付；本阶段只给标注集构造与判定规则。",
    )
)

register_metric(
    MetricSpec(
        name="booking_usage_rate",
        title="在线预约使用率",
        pack="guide-match-profile",
        definition=(
            "有讲解预约需求的访客中，最终成功使用（提交）在线预约的比例。"
        ),
        formula="usage_rate = 提交预约的访客数 ÷ 进入预约入口（有预约需求）的访客数",
        numerator="去重访客数：产生 book_guide（提交预约）事件",
        denominator="去重访客数：进入讲解预约入口（预约页曝光）",
        data_source=(
            "algo_visitor_events 视图（基表 visitor_events）；"
            "分母事件类型 view_booking 尚未在契约枚举内（TODO：契约增补）"
        ),
        sample_requirement="≥ 200 个进入预约入口的访客",
        boundary=(
            "分母只算「进入预约入口」的访客，不能用全部游客做分母；"
            "进入入口但未选讲解员/时段的不算使用；重复提交同一单只算一个访客"
        ),
        example="180 人进入预约入口，57 人提交 → 31.7% ≥ 30% 达标",
        unit="ratio",
        target_op=">=",
        target_value=0.30,
        target_display="≥ 30%",
        direction="higher_is_better",
        doc_ref="docs/metrics-definition.md#2-6-在线预约使用率",
        status_hint="pack",
        evidence="pack-provided",
        notes="guide-match-profile 包交付后注册实现；本阶段为桩。",
    )
)

register_metric(
    MetricSpec(
        name="booking_confirmation_duration_min",
        title="平均预约确认时长",
        pack="guide-match-profile",
        definition=(
            "从游客提交预约到讲解员/客服确认（或明确拒绝）的平均耗时。"
        ),
        formula="duration = decided_at − requested_at；指标 = mean(duration) （分钟）",
        numerator="Σ(decided_at − requested_at)（对未被取消的预约求和）",
        denominator="有效预约单数（status ∈ {confirmed, rejected, completed}）",
        data_source="bookings 基表（requested_at / decided_at / status）+ booking_events 留痕表",
        sample_requirement="≥ 100 单有效预约",
        boundary=(
            "取消单（status=cancelled）默认剔除，另报取消率；"
            "decided_at 为空的未决单不计入分母，但必须单列「待确认积压数」；"
            "跨天确认按真实时间差计，不做截断"
        ),
        example="120 单有效预约，确认耗时均值 21.4 分钟 → ≤ 30 分钟 达标",
        unit="minutes",
        target_op="<=",
        target_value=30.0,
        target_display="≤ 30 分钟",
        direction="lower_is_better",
        doc_ref="docs/metrics-definition.md#2-7-平均预约确认时长",
        status_hint="pack",
        evidence="pack-provided",
        notes="guide-match-profile 包交付后注册实现；本阶段为桩。",
    )
)

register_metric(
    MetricSpec(
        name="parking_mae_ratio_1h",
        title="未来 1 小时车位预测 MAE（主口径·相对总车位）",
        pack="parking-forecast",
        definition=(
            "预测未来 1 小时（horizon=60 分钟）某车场空闲车位数，与其真实空闲车位的平均绝对误差，"
            "再除以该车场车位总数，得到无量纲比例。这是「MAE ≤ 20%」的**验收主口径**。"
        ),
        formula=(
            "MAE_ratio = mean(|pred_free − actual_free|) / total_spaces"
            "（单车场；多车场汇总用 sum|e| / sum(total_spaces)，即按车位容量加权）"
        ),
        numerator="Σ|预测空闲车位 − 真实空闲车位|（车位）",
        denominator="车位总数 total_spaces（每车场固定容量；多车场汇总时为 Σ total_spaces）",
        data_source=(
            "algo_parking_history 视图（基表 parking_observations，quality='ok' 的桶）"
            " + parking-forecast 回测输出的 predicted_free_spaces"
        ),
        sample_requirement=(
            "≥ 500 个 quality='ok' 的评估桶，且每个车场 ≥ 100 个桶；"
            "评估窗口须包含工作日/周末、节假日、≥ 2 种天气"
        ),
        boundary=(
            "缺失桶（quality='missing'，free_spaces 为 NULL）不进入分子分母，"
            "其覆盖率单独统计；过期桶（quality='stale'）不进入主口径，"
            "另出 stale 桶的误差与覆盖率；total_spaces 为 NULL 的桶剔除"
        ),
        example=(
            "total_spaces=100、平均绝对误差 8 个车位 → MAE_ratio=8%（达标）；"
            "MAE_spaces=8 车位；MAE_pp=8 个百分点（total=100 时数值相同但分母不同）"
        ),
        unit="ratio",
        target_op="<=",
        target_value=0.20,
        target_display="≤ 20%",
        direction="lower_is_better",
        doc_ref="docs/metrics-definition.md#2-8-未来-1-小时车位预测-mae",
        status_hint="builtin",
        evidence="synthetic-offline",
        notes="本阶段用合成评测集验证计算链路；需求方书面确认放在上线阶段。",
    )
)

register_metric(
    MetricSpec(
        name="parking_mae_spaces_1h",
        title="未来 1 小时车位预测 MAE（并列口径·车位）",
        pack="parking-forecast",
        definition="主口径的等价车位数表达：平均绝对误差，单位是个车位。",
        formula="MAE_spaces = mean(|pred_free − actual_free|)；MAE_ratio = MAE_spaces / total_spaces",
        numerator="—（绝对误差均值，单位车位）",
        denominator="—（单位车位，不做归一化）",
        data_source="同 parking_mae_ratio_1h",
        sample_requirement="同 parking_mae_ratio_1h",
        boundary="分母为车位数时不可直接与「20%」比较，须先乘 total_spaces 换算",
        example="total_spaces=100 时 MAE_spaces=8 车位，对应 MAE_ratio=8%",
        unit="spaces",
        target_op="<=",
        target_value=None,
        target_display="并列呈现（换算后同 ≤20%）",
        direction="lower_is_better",
        role="auxiliary",
        doc_ref="docs/metrics-definition.md#2-8-未来-1-小时车位预测-mae",
        status_hint="builtin",
        evidence="synthetic-offline",
        notes="辅助列，不单独判定达标。",
    )
)

register_metric(
    MetricSpec(
        name="parking_mae_pp_1h",
        title="未来 1 小时车位预测 MAE（并列口径·百分点）",
        pack="parking-forecast",
        definition=(
            "空置率（比例）口径的平均绝对误差，单位是百分点（pp）。"
            "与主口径分母不同，不可与 MAE_ratio 混用。"
        ),
        formula="MAE_pp = mean(|pred_free/total − actual_free/total|) × 100",
        numerator="Σ|(预测空置率 − 真实空置率)|（比例）",
        denominator="样本数（每样本先各自除以本车场 total_spaces 再求均值）",
        data_source="同 parking_mae_ratio_1h",
        sample_requirement="同 parking_mae_ratio_1h",
        boundary=(
            "多车场容量不同时，MAE_pp 是「逐样本先归一化再平均」，与 MAE_ratio 的"
            "「汇总归一化」不同，两者不可互相换算"
        ),
        example="total_spaces=100、平均绝对误差 8 个车位 → MAE_pp=8.0 个百分点",
        unit="pp",
        target_op="<=",
        target_value=None,
        target_display="并列呈现（换算后同 ≤20%）",
        direction="lower_is_better",
        role="auxiliary",
        doc_ref="docs/metrics-definition.md#2-8-未来-1-小时车位预测-mae",
        status_hint="builtin",
        evidence="synthetic-offline",
        notes="辅助列，不单独判定达标。",
    )
)

register_metric(
    MetricSpec(
        name="parking_offpeak_adoption_rate",
        title="错峰建议采纳率",
        pack="parking-forecast",
        definition=(
            "向访客给出「错峰停车」建议（建议晚到/早走以避开高峰）后，实际采纳该建议的比例。"
        ),
        formula="rate = 采纳错峰建议的次数 ÷ 展示错峰建议的次数",
        numerator="adopt_parking 事件数（采纳了含错峰建议的停车卡片）",
        denominator="view_parking 事件数（展示了含错峰建议的停车卡片）",
        data_source=(
            "algo_visitor_events 视图（基表 visitor_events）"
            "event_type ∈ {view_parking, adopt_parking}；线上需曝光级 offpeak 标记"
        ),
        sample_requirement="≥ 200 次含错峰建议的展示",
        boundary=(
            "分母只算**含错峰建议**的停车卡片曝光，普通余位查询不算；"
            "同一访客对同一张卡片的重复点击只计一次；用户自行改选其它车场不计采纳"
        ),
        example="240 次展示、66 次采纳 → 27.5% ≥ 25% 达标",
        unit="ratio",
        target_op=">=",
        target_value=0.25,
        target_display="≥ 25%",
        direction="higher_is_better",
        doc_ref="docs/metrics-definition.md#2-9-错峰建议采纳率",
        status_hint="builtin",
        evidence="synthetic-offline",
        notes="本阶段用合成事件流验证计算链路。",
    )
)

register_metric(
    MetricSpec(
        name="first_screen_load_ms",
        title="首屏加载时间（p95）",
        pack="performance",
        definition=(
            "小程序冷启动到首页首屏可交互的耗时（首屏渲染完成 + 首屏关键数据返回）。"
        ),
        formula="load_ms = t(首屏可交互) − t(冷启动)",
        numerator="—（时延类）",
        denominator="—（样本量 = 冷启动次数 n）",
        data_source="真机性能采样（冷启动脚本 + 监控上报）",
        sample_requirement=(
            "≥ 100 次冷启动，覆盖 3 档机型（高/中/低）与 ≥ 2 种网络（4G/Wi-Fi）"
        ),
        boundary="弱网重试与二次启动单独统计；报告必须按机型档位分列，整体 p95 不得掩盖低档机型",
        example="高档机 p95=1180ms、中档 1620ms、低档 2350ms → 低档 ≤ 2000ms 未达标，需列整改项",
        unit="ms",
        target_op="<=",
        target_value=2000.0,
        target_display="≤ 2000 ms（p95）",
        direction="lower_is_better",
        doc_ref="docs/metrics-definition.md#2-10-首屏加载--关键页面响应",
        status_hint="pack",
        evidence="pack-provided",
        notes="需要真机采样；本阶段为桩。",
    )
)

register_metric(
    MetricSpec(
        name="page_response_ms_p95",
        title="关键页面响应时间（p95）",
        pack="performance",
        definition=(
            "关键页面（路线推荐页、停车查询页、讲解播放页、预约页）主接口的响应耗时 p95。"
        ),
        formula="response_ms = t(接口响应完成) − t(请求发出)",
        numerator="—（时延类）",
        denominator="—（样本量 = 关键接口请求数 n）",
        data_source="真机/网关接口耗时采样（按页面-接口维度分组）",
        sample_requirement="每个关键接口 ≥ 200 次请求，覆盖 3 档机型",
        boundary="只统计服务端耗时口径的接口；纯前端渲染耗时不计入；每个接口单独判定",
        example="路线推荐接口 p95=1180ms、停车查询 p95=980ms → 均 ≤ 1500ms 达标",
        unit="ms",
        target_op="<=",
        target_value=1500.0,
        target_display="≤ 1500 ms（p95）",
        direction="lower_is_better",
        doc_ref="docs/metrics-definition.md#2-10-首屏加载--关键页面响应",
        status_hint="pack",
        evidence="pack-provided",
        notes="需要真机采样；本阶段为桩。",
    )
)

register_metric(
    MetricSpec(
        name="core_availability_rate",
        title="核心功能可用率",
        pack="system",
        definition=(
            "统计周期内，核心功能请求中成功完成（非 5xx、非超时、非服务端错误）的比例。"
        ),
        formula="availability = 成功请求数 ÷ 核心功能请求总数",
        numerator="成功完成的核心功能请求数",
        denominator="核心功能请求总数（含失败）",
        data_source="网关/服务端请求日志（核心接口清单见口径书）",
        sample_requirement="按自然周统计，单周期请求量 ≥ 10000；覆盖全部核心接口",
        boundary=(
            "剔除客户端主动取消、参数校验失败（4xx）与用户端网络切换造成的中断；"
            "超时按服务端阈值（3 秒）判定；5xx 全部计为失败；"
            "统计周期内请求量不足 10000 的周期不单独判定"
        ),
        example="一周 128,400 次核心请求、失败 42 次 → 99.967% ≥ 99.5% 达标",
        unit="ratio",
        target_op=">=",
        target_value=0.995,
        target_display="≥ 99.5%",
        direction="higher_is_better",
        doc_ref="docs/metrics-definition.md#2-11-核心功能可用率",
        status_hint="pack",
        evidence="pack-provided",
        notes="需要生产/预发日志；本阶段为桩。",
    )
)
