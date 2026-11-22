"""最小 JSON Schema draft 2020-12 子集校验器（不依赖第三方 `jsonschema`）。

支持的关键字（与 02 §5 / 05 阶段 1 一致）：
    type / required / properties / enum / minimum / maximum / additionalProperties(false)

`type` 既可为单个类型名，也可为类型名列表（union，如 ``["integer", "null"]``），
以表达「允许 null」的字段。数组只校验 ``type == array``，数组元素深度校验
由阶段 3 的 ``check.mjs`` 负责（设计文档明确如此划分）。

校验失败返回结构化错误列表，不抛裸异常；空列表表示通过。
每个错误为 ``{"path": "...", "reason": "..."}``，path 以 ``$`` 为根。
"""

from __future__ import annotations

from typing import Any, List, Dict

__all__ = ["validate"]


def _type_name(value: Any) -> str:
    """返回实例在 JSON 语义下的类型名（bool 与 int 分离，因为 JSON 里二者不同）。"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _matches_type(instance: Any, expected: str) -> bool:
    """JSON Schema 里 ``number`` 包含整数与浮点，其余类型精确匹配。"""
    actual = _type_name(instance)
    if expected == "number":
        return actual in ("integer", "number")
    return actual == expected


def _validate(instance: Any, schema: Dict[str, Any], path: str) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []

    if not isinstance(schema, dict):
        return errors

    # ---- type ----
    if "type" in schema:
        expected = schema["type"]
        if isinstance(expected, str):
            if not _matches_type(instance, expected):
                errors.append({
                    "path": path,
                    "reason": "expected type %r, got %s" % (expected, _type_name(instance)),
                })
        elif isinstance(expected, list):
            if not any(_matches_type(instance, t) for t in expected):
                errors.append({
                    "path": path,
                    "reason": "expected one of types %r, got %s" % (expected, _type_name(instance)),
                })

    # ---- enum ----
    if "enum" in schema:
        enum_values = schema["enum"]
        if not any(instance == e for e in enum_values):
            errors.append({
                "path": path,
                "reason": "value %r not in enum %r" % (instance, enum_values),
            })

    # ---- minimum / maximum（仅对数值生效；bool 是 int 的子类，需排除）----
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append({
                "path": path,
                "reason": "%r is less than minimum %r" % (instance, schema["minimum"]),
            })
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append({
                "path": path,
                "reason": "%r is greater than maximum %r" % (instance, schema["maximum"]),
            })

    # ---- object：required / properties / additionalProperties ----
    if isinstance(instance, dict):
        if "required" in schema:
            for req in schema["required"]:
                if req not in instance:
                    errors.append({
                        "path": path,
                        "reason": "missing required property %r" % req,
                    })

        props = schema.get("properties", {}) or {}
        for key, subschema in props.items():
            if key in instance:
                errors.extend(_validate(instance[key], subschema, "%s.%s" % (path, key)))

        additional = schema.get("additionalProperties", True)
        if additional is False:
            for key in instance:
                if key in props:
                    continue
                errors.append({
                    "path": path,
                    "reason": "additional property %r not allowed" % key,
                })

    # ---- array：子集只校验 type，不校验 items ----
    return errors


def validate(instance: Any, schema: Dict[str, Any]) -> List[Dict[str, str]]:
    """校验 ``instance`` 是否符合 ``schema``，返回错误列表（空 = 通过）。"""
    if not isinstance(schema, dict):
        return [{"path": "$", "reason": "schema must be an object"}]
    return _validate(instance, schema, "$")
