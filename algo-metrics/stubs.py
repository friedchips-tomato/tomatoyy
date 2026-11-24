"""未交付包的指标桩函数（algo-metrics / 任务 M4）。

并行开发期，各算法包（route-recommender / kg-recommend / guide-match-profile / AI 讲解 /
性能 / 系统）还没交付可复算的产物，本模块为它们的指标提供**桩**：

    {"value": null, "status": "not_implemented", "note": "..."}

**桩不得编造数字**——没有值就是没有值。归属包交付后调用
``registry.register_pack_metrics(pack, {...})`` 覆盖桩即可，runner 与报告无需改动。

每个桩的 note 都写明「缺什么、谁来补、怎么补」，方便集成阶段逐条销项。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

import registry

__all__ = ["stub_impl", "register_stubs", "STUB_NOTES"]


# 指标名 → 桩说明（写清楚缺什么、找谁补）
STUB_NOTES: Dict[str, str] = {
    "route_generation_latency_ms": (
        "待 route-recommender 包交付：需要 100 点位规模下的路线生成耗时采样"
        "（route_result.json 的 generated_ms），≥100 次请求。"
    ),
    "kg_recommendation_ctr": (
        "待 kg-recommend 包交付：需要 KG 语义推荐卡片的曝光/点击埋点"
        "（含 impression_id 以便去重），≥500 条曝光。"
        "注：KG 曝光/点击事件类型尚未进入 CONTRACT §4.5 事件枚举，需契约增补。"
    ),
    "voice_naturalness_mos": (
        "待 AI 讲解包交付：需要 MOS 问卷与 ≥30 份有效听测问卷（3 题项），"
        "覆盖普通话/粤语/外语。"
    ),
    "guide_point_match_accuracy": (
        "待 AI 讲解包交付：需要 ≥200 条讲解抽检标注集与点位匹配判定结果。"
    ),
    "booking_usage_rate": (
        "待 guide-match-profile 包交付：需要预约入口曝光（view_booking）与提交预约"
        "（book_guide）两类事件，≥200 个进入预约入口的访客。"
        "注：view_booking 尚未进入 CONTRACT §4.5 事件枚举，需契约增补。"
    ),
    "booking_confirmation_duration_min": (
        "待 guide-match-profile 包交付：需要 bookings 的 requested_at / decided_at / status，"
        "≥100 单有效预约。"
    ),
    "first_screen_load_ms": "待性能采样交付：需要真机冷启动采样（≥100 次，3 档机型）。",
    "page_response_ms_p95": "待性能采样交付：需要关键接口耗时采样（每接口 ≥200 次）。",
    "core_availability_rate": "待系统交付：需要网关/服务端核心接口日志（自然周）。",
}


def stub_impl(
    name: str, pack: str, note: Optional[str] = None, unit: Optional[str] = None
) -> Callable[[], Dict[str, Any]]:
    """生成一个指标桩函数。

    :param name: 指标名。
    :param pack: 归属包名。
    :param note: 桩说明；缺省取 :data:`STUB_NOTES`。
    :param unit: 单位；缺省取注册表里声明的单位。
    """
    text = note or STUB_NOTES.get(name, "归属包 %s 尚未交付实现。" % pack)

    def _stub() -> Dict[str, Any]:
        spec = registry.get_metric(name)
        resolved_unit = unit or (spec.unit if spec else None)
        return {
            "value": None,
            "unit": resolved_unit,
            "n": 0,
            "status": "not_implemented",
            "note": text,
        }

    _stub.__name__ = "stub_%s" % name
    _stub.__doc__ = text
    return _stub


def register_stubs() -> Dict[str, Callable[[], Dict[str, Any]]]:
    """给所有尚无实现的指标挂上桩，并返回 {指标名: 桩函数}。"""
    created: Dict[str, Callable[[], Dict[str, Any]]] = {}
    for spec in registry.list_metrics():
        if spec.impl is not None:
            continue
        if spec.status_hint not in ("pack", "future"):
            continue
        impl = stub_impl(spec.name, spec.pack, unit=spec.unit)
        registry.register_impl(spec.name, impl)
        created[spec.name] = impl
    return created
