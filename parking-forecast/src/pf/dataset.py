"""统一读取层（合成 / 真实同入口）。本阶段只实现合成分支；真实分支留接口桩。

契约（02 §4）：
    - 合成：读 ``data/synthetic/*.jsonl``。
    - 真实：读 ``CHANGDI_PARKING_OBSERVATIONS`` 指向的目录或数据库。
    - 统一：按 lot_id/ts 排序、去重（同 lot 同 ts 保留 quality 最高的一条）、标注 staleness。

真实数据接入的契约要求（写在这里，供日后对接方照做）：
    - 每条观测至少给 ``lot_id`` / ``ts`` / ``free_spaces`` / ``source``；
    - 缺失时刻**直接不产出行**，或产出行且 ``free_spaces=null`` + ``quality=missing``，
      二者等价，但**不要插值、不要前向填充**；
    - 历史覆盖建议 ≥ 8 周、粒度 ≤ 15 分钟，且包含至少一次节假日或大活动。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

__all__ = ["Dataset", "DatasetConfig", "load_observations", "QUALITY_RANK"]

# quality 越高越优先保留；ok 是最新鲜可信，stale 是真实但旧，suspect 值可能错，missing 无值。
QUALITY_RANK = {"ok": 3, "stale": 2, "suspect": 1, "missing": 0}


@dataclass
class Dataset:
    lots: List[Dict[str, Any]]
    observations: List[Dict[str, Any]]
    signals: List[Dict[str, Any]]


@dataclass
class DatasetConfig:
    source: str = "synthetic"  # "synthetic" | "real"
    data_dir: str = "data/synthetic"


def load_observations(config: Optional[DatasetConfig] = None) -> Dataset:
    """读取 lots + observations + signals，返回统一 ``Dataset``。

    - 合成：读 ``data_dir/lots.jsonl`` / ``observations.jsonl`` / ``signals.jsonl``。
    - 真实：接口桩，TODO（阶段 2 接入）。
    """
    if config is None:
        config = DatasetConfig()

    if config.source == "synthetic":
        return _load_synthetic(config.data_dir)

    # TODO: 真实数据分支（本阶段不实现）。
    # 读取 CHANGDI_PARKING_OBSERVATIONS 指向的目录或数据库，映射到同一批 schema 字段，
    # 之后走与合成完全相同的排序 / 去重逻辑。
    raise NotImplementedError("真实数据读取分支未实现（阶段 2 接入 CHANGDI_PARKING_OBSERVATIONS）")


def _load_synthetic(data_dir: str) -> Dataset:
    base = Path(data_dir)
    lots = _read_jsonl(base / "lots.jsonl")
    observations = _read_jsonl(base / "observations.jsonl")
    signals = _read_jsonl(base / "signals.jsonl")
    observations = _dedup_sort(observations)
    return Dataset(lots=lots, observations=observations, signals=signals)


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _dedup_sort(observations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按 lot_id/ts 排序；同 lot 同 ts 去重，保留 quality 最高的一条。"""
    observations = sorted(observations, key=lambda o: (o["lot_id"], o["ts"]))
    deduped: Dict[tuple, Dict[str, Any]] = {}
    for o in observations:
        key = (o["lot_id"], o["ts"])
        if key not in deduped:
            deduped[key] = o
        elif QUALITY_RANK.get(o.get("quality"), -1) > QUALITY_RANK.get(deduped[key].get("quality"), -1):
            deduped[key] = o
    return [deduped[k] for k in sorted(deduped)]
