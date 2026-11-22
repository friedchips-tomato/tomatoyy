"""验收标准 1.1：六份 schema 齐备 + record 对象 additionalProperties:false + 最小校验器行为。

缺字段报错、多字段报错、枚举越界报错。
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pf.schema import validate  # noqa: E402

SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schemas"
SCHEMA_FILES = [
    "lot.schema.json",
    "observation.schema.json",
    "signals.schema.json",
    "forecast.schema.json",
    "recommendation.schema.json",
    "artifact.schema.json",
]

DRAFT = "https://json-schema.org/draft/2020-12/schema"


def _schema(name: str):
    with open(SCHEMA_DIR / name, "r", encoding="utf-8") as f:
        return json.load(f)


def _iter_object_subschemas(schema, path="$"):
    """递归遍历 schema 的 properties，产出所有「record 对象」子 schema。"""
    yield path, schema
    for key, sub in (schema.get("properties") or {}).items():
        t = sub.get("type")
        is_object = t == "object" or (isinstance(t, list) and "object" in t)
        if is_object:
            yield from _iter_object_subschemas(sub, "%s.%s" % (path, key))


# --------------------------------------------------------------------------- #
# 1.1 六份 schema 齐备 + additionalProperties:false
# --------------------------------------------------------------------------- #
def test_six_schemas_present_and_draft2020_12():
    assert all((SCHEMA_DIR / f).exists() for f in SCHEMA_FILES)
    for f in SCHEMA_FILES:
        s = _schema(f)
        assert s["$schema"] == DRAFT, f


def test_every_record_object_forbids_additional_properties():
    for f in SCHEMA_FILES:
        schema = _schema(f)
        for path, sub in _iter_object_subschemas(schema):
            assert sub.get("additionalProperties") is False, (
                "%s 的对象 %s 未设置 additionalProperties:false" % (f, path)
            )


# --------------------------------------------------------------------------- #
# 最小校验器：type / required / enum / minimum / maximum / additionalProperties
# --------------------------------------------------------------------------- #
def test_validator_type():
    s = {"type": "integer"}
    assert validate(3, s) == []
    assert validate(3.0, s) != []
    assert validate("3", s) != []


def test_validator_type_union_null():
    s = {"type": ["integer", "null"]}
    assert validate(3, s) == []
    assert validate(None, s) == []
    assert validate("x", s) != []


def test_validator_number_includes_integer():
    s = {"type": "number"}
    assert validate(3, s) == []
    assert validate(3.5, s) == []


def test_validator_bool_not_integer():
    s = {"type": "integer"}
    assert validate(True, s) != []


def test_validator_required():
    s = {"type": "object", "required": ["a"], "properties": {"a": {"type": "integer"}}}
    assert validate({"a": 1}, s) == []
    assert validate({}, s) != []


def test_validator_enum():
    s = {"enum": ["ok", "stale"]}
    assert validate("ok", s) == []
    assert validate("weird", s) != []


def test_validator_minimum_maximum():
    s = {"type": "number", "minimum": 0, "maximum": 1}
    assert validate(0.5, s) == []
    assert validate(-0.1, s) != []
    assert validate(1.1, s) != []
    # 非数值不受 minimum/maximum 约束
    assert validate(None, {"type": ["number", "null"], "minimum": 0}) == []


def test_validator_additional_properties_false():
    s = {"type": "object", "properties": {"a": {"type": "integer"}}, "additionalProperties": False}
    assert validate({"a": 1}, s) == []
    assert validate({"a": 1, "bogus": 2}, s) != []


def test_validator_error_has_path_and_reason():
    s = {"type": "object", "properties": {"fee": {"type": "object", "properties": {"mode": {"enum": ["hourly"]}}}}}
    errors = validate({"fee": {"mode": "free"}}, s)
    assert errors
    assert all("path" in e and "reason" in e for e in errors)
    assert any(e["path"] == "$.fee.mode" for e in errors)


# --------------------------------------------------------------------------- #
# 缺字段 / 多字段 / 枚举越界（基于真实 schema）
# --------------------------------------------------------------------------- #
def test_lot_missing_field_errors():
    lot = {
        "name": "测试车场",
        "total_spaces": 100,
        "fee": {"mode": "hourly", "amount": 5.0, "unit": "CNY", "note": ""},
        "access": {"open_hours": "00:00-24:00", "one_way": False, "restricted_hours": [], "height_limit_m": None, "note": ""},
        "walk_to_street": {"meters": 100, "minutes": 2},
        "source": "synthetic",
    }
    errors = validate(lot, _schema("lot.schema.json"))
    assert errors
    assert any("lot_id" in e["reason"] for e in errors)


def test_lot_extra_field_errors():
    lot = {
        "lot_id": "P1",
        "name": "测试车场",
        "total_spaces": 100,
        "fee": {"mode": "hourly", "amount": 5.0, "unit": "CNY", "note": ""},
        "access": {"open_hours": "00:00-24:00", "one_way": False, "restricted_hours": [], "height_limit_m": None, "note": ""},
        "walk_to_street": {"meters": 100, "minutes": 2},
        "source": "synthetic",
        "bogus": 1,
    }
    errors = validate(lot, _schema("lot.schema.json"))
    assert errors
    assert any("bogus" in e["reason"] for e in errors)


def test_observation_enum_out_of_range_errors():
    obs = {
        "lot_id": "P1",
        "ts": "2026-04-01T08:00:00+08:00",
        "free_spaces": 50,
        "source": "synthetic",
        "quality": "weird",
    }
    errors = validate(obs, _schema("observation.schema.json"))
    assert errors
    assert any("enum" in e["reason"] for e in errors)


# --------------------------------------------------------------------------- #
# 合法样例应通过（生成器自检的同款断言）
# --------------------------------------------------------------------------- #
def _valid_lot():
    return {
        "lot_id": "P1",
        "name": "测试车场",
        "total_spaces": 100,
        "fee": {"mode": "hourly", "amount": 5.0, "unit": "CNY", "note": ""},
        "access": {"open_hours": "00:00-24:00", "one_way": False, "restricted_hours": [], "height_limit_m": None, "note": ""},
        "geometry": None,
        "walk_to_street": {"meters": 100, "minutes": 2},
        "district": None,
        "source": "synthetic",
        "notes": None,
    }


def _valid_observation():
    return {"lot_id": "P1", "ts": "2026-04-01T08:00:00+08:00", "free_spaces": 50, "total_spaces": 100,
            "source": "synthetic", "quality": "ok"}


def test_valid_lot_passes():
    assert validate(_valid_lot(), _schema("lot.schema.json")) == []


def test_valid_observation_variants_pass():
    ok = _valid_observation()
    assert validate(ok, _schema("observation.schema.json")) == []

    missing = dict(ok, free_spaces=None, quality="missing")
    assert validate(missing, _schema("observation.schema.json")) == []

    stale = dict(ok, quality="stale", age_seconds=300)
    assert validate(stale, _schema("observation.schema.json")) == []


def test_valid_signals_pass():
    calendar = {"lot_id": "ALL", "ts": "2026-04-01T08:00:00+08:00", "kind": "calendar",
                "is_workday": True, "is_holiday": False, "holiday_name": None, "peak": "am_peak", "source": "synthetic"}
    assert validate(calendar, _schema("signals.schema.json")) == []

    weather = {"lot_id": "ALL", "ts": "2026-04-01T08:00:00+08:00", "kind": "weather",
               "weather": "rain", "temperature_c": 22.5, "source": "synthetic"}
    assert validate(weather, _schema("signals.schema.json")) == []

    event = {"lot_id": "ALL", "ts": "2026-04-01T18:00:00+08:00", "kind": "event",
             "event_id": "E1", "event_name": "夜市", "event_strength": 0.6, "source": "synthetic"}
    assert validate(event, _schema("signals.schema.json")) == []


def test_valid_forecast_passes():
    f = {"lot_id": "P1", "issued_at": "2026-04-01T08:00:00+08:00", "target_ts": "2026-04-01T09:00:00+08:00",
         "horizon_minutes": 60, "point_free": 12, "p10": 8, "p90": 16, "free_rate": 0.12,
         "method": "model", "degraded": False, "degrade_reason": None, "model_version": "v1",
         "data_asof": "2026-04-01T07:59:00+08:00", "source": "synthetic"}
    assert validate(f, _schema("forecast.schema.json")) == []


def test_valid_recommendation_passes():
    r = {"destination_id": "CD-A01", "arrive_at": "2026-04-01T09:00:00+08:00", "preference": "save_time",
         "generated_at": "2026-04-01T08:00:00+08:00", "items": [], "alternates": [], "source": "synthetic"}
    assert validate(r, _schema("recommendation.schema.json")) == []


def test_valid_artifact_passes():
    a = {"schema_version": "1.0.0", "generated_at": "2026-04-01T08:00:00+08:00", "model_version": "v1",
         "data_fingerprint": "abc", "source": "synthetic", "lots": [], "forecasts": [], "recommendations": []}
    assert validate(a, _schema("artifact.schema.json")) == []
