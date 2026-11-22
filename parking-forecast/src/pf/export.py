"""产物导出（03 §3.3 / §3.6）。

``build_model_artifact`` 把训练好的模型 + 排名参数 + 车场清单序列化成
``artifacts/model.json``（``{version, kind, features, payload, ranking_caps,
ranking_weights, lots, trained_at, data_fingerprint, source}``），可被 JS 运行时
逐位一致地解释执行。``to_jsonable`` 保证 numpy 标量都转成原生 JSON 类型，
``write_json`` 以 ``sort_keys`` 写出确定性 JSON。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from .recommend import RANKING_CAPS, RANKING_WEIGHTS

__all__ = [
    "build_model_artifact",
    "to_jsonable",
    "write_json",
    "write_text",
    "data_fingerprint",
    "ARTIFACT_SCHEMA_VERSION",
]

ARTIFACT_SCHEMA_VERSION = "2.0.0"


def to_jsonable(obj: Any) -> Any:
    """递归把 numpy 标量 / ndarray 转成原生 JSON 类型（保证 json.dump 可写且可 round-trip）。"""
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [to_jsonable(v) for v in obj.tolist()]
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, bool):
        return bool(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, float):
        return float(obj)
    if isinstance(obj, int):
        return int(obj)
    return obj


def build_model_artifact(model: Dict[str, Any], lots: List[Dict[str, Any]],
                         trained_at: str, fingerprint: str,
                         source: str = "synthetic") -> Dict[str, Any]:
    """构造可被 JS 运行时解释的 ``model.json`` 契约（03 §3.3）。"""
    return to_jsonable({
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "version": model["version"],
        "kind": model["kind"],
        "features": model["feature_names"],
        "payload": {
            "horizons": model["horizons"],
            "scaler": model["scaler"],
            "residual_quantiles": model["residual_quantiles"],
            "feature_fills": model["feature_fills"],
            "calendar": model["calendar"],
        },
        "ranking_caps": RANKING_CAPS,
        "ranking_weights": RANKING_WEIGHTS,
        "lots": lots,
        "trained_at": trained_at,
        "data_fingerprint": fingerprint,
        "source": source,
    })


def data_fingerprint(manifest: Dict[str, Any]) -> str:
    """从数据 manifest 的 file_sha256 派生数据指纹（复算追溯）。"""
    shas = manifest.get("file_sha256", {})
    return ":".join(shas.get(f, "?") for f in ("lots.jsonl", "observations.jsonl", "signals.jsonl"))


def write_json(path, obj: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n"：生成物一律以 LF 落盘，不受平台默认换行转换影响。
    # 这样「磁盘字节 = Git blob 字节 = 被哈希的字节」三者在任何平台都相等，
    # manifest 里记录的 SHA-256 才是可用的完整性凭据（见 scripts/report.py 的 files 字段）。
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(to_jsonable(obj), f, ensure_ascii=False, sort_keys=True, indent=2)
        f.write("\n")


def write_text(path, text: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
