"""合成评测集的字段、覆盖度与可复现性测试。"""

from __future__ import annotations

import csv
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

PKG_DIR = Path(__file__).resolve().parents[1]
DATASETS = PKG_DIR / "datasets"
MANIFEST = json.loads((DATASETS / "manifest.json").read_text(encoding="utf-8"))

CONTRACT_PARKING_COLUMNS = [
    "parking_id", "ts", "occupied_spaces", "free_spaces", "total_spaces", "weekday",
    "is_holiday", "weather", "event_flag", "data_source",
]
CONTRACT_EVENT_COLUMNS = [
    "visitor_id", "ts", "event_type", "point_id", "route_id", "dwell_seconds",
    "interest_tags", "device_lang",
]
CONTRACT_EVENT_TYPES = {
    "view_route", "adopt_route", "finish_route", "arrive_point", "listen_guide",
    "ask_question", "view_parking", "adopt_parking", "book_guide", "feedback",
}
IMPRESSION_COLUMNS = [
    "impression_id", "visitor_id", "ts", "algo_version", "side_focus", "shown_point_ids",
    "adopted", "dwell_seconds",
]


def _rows(name):
    with (DATASETS / name).open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


@pytest.mark.parametrize(
    "name,required",
    [
        ("parking_observations_sample.csv", CONTRACT_PARKING_COLUMNS),
        ("visitor_events_sample.csv", CONTRACT_EVENT_COLUMNS),
        ("route_impressions_sample.csv", IMPRESSION_COLUMNS),
    ],
)
def test_csv_has_contract_columns(name, required):
    with (DATASETS / name).open("r", encoding="utf-8", newline="") as handle:
        header = next(csv.reader(handle))
    for column in required:
        assert column in header, "%s 缺少契约字段 %s" % (name, column)


def test_all_rows_marked_synthetic():
    for name in [
        "parking_observations_sample.csv",
        "visitor_events_sample.csv",
        "route_impressions_sample.csv",
    ]:
        rows = _rows(name)
        assert rows
        assert all(row["data_source"] == "synthetic" for row in rows)


def test_parking_dataset_covers_required_scenarios():
    rows = _rows("parking_observations_sample.csv")
    assert any(int(r["weekday"]) < 5 for r in rows)      # 工作日
    assert any(int(r["weekday"]) >= 5 for r in rows)     # 周末
    assert any(r["is_holiday"] == "1" for r in rows)     # 节假日
    assert len({r["weather"] for r in rows}) >= 3        # 多天气
    assert any(r["event_flag"] == "1" for r in rows)     # 活动标记
    qualities = {r["quality"] for r in rows}
    assert {"ok", "stale", "missing"} <= qualities       # 缺值/过期样本
    missing = [r for r in rows if r["quality"] == "missing"]
    assert all(r["free_spaces"] == "" for r in missing)   # 缺桶不补零
    assert all(r["occupied_spaces"] == "" for r in missing)


def test_parking_evaluable_rows_have_prediction_and_true_value():
    rows = _rows("parking_observations_sample.csv")
    usable = [r for r in rows if r["quality"] == "ok" and r["predicted_free_spaces"] != ""]
    assert len(usable) >= 500
    for row in usable:
        assert 0 <= int(row["free_spaces"]) <= int(row["total_spaces"])
        assert 0 <= int(row["predicted_free_spaces"]) <= int(row["total_spaces"])
        assert row["horizon_min"] == "60"


def test_visitor_events_cover_all_contract_event_types():
    rows = _rows("visitor_events_sample.csv")
    types = {r["event_type"] for r in rows}
    assert CONTRACT_EVENT_TYPES <= types
    assert any(r["dwell_seconds"] == "" for r in rows)   # 缺值样本
    assert any(r["point_id"] == "" for r in rows)
    assert any(r["route_id"] == "" for r in rows)


def test_route_impressions_cover_adopted_and_not_adopted():
    rows = _rows("route_impressions_sample.csv")
    adopted = {r["adopted"] for r in rows}
    assert adopted == {"0", "1"}
    assert {r["side_focus"] for r in rows} == {"culture", "distance", "depth"}
    assert len({r["impression_id"] for r in rows}) == len(rows)


def test_manifest_records_seed_and_hashes():
    assert MANIFEST["seed"] == 20261122
    assert MANIFEST["data_source"] == "synthetic"
    assert MANIFEST["verified"] is False
    for name, meta in MANIFEST["files"].items():
        digest = hashlib.sha256((DATASETS / name).read_bytes()).hexdigest()
        assert digest == meta["sha256"], name


def test_generator_is_reproducible(tmp_path):
    """同种子重跑，产出逐字节一致。"""
    out = tmp_path / "regen"
    out.mkdir()
    result = subprocess.run(
        [sys.executable, str(DATASETS / "gen_datasets.py"), "--seed", "20261122",
         "--out", str(out)],
        capture_output=True, text=True, encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    for name in [
        "parking_observations_sample.csv",
        "visitor_events_sample.csv",
        "route_impressions_sample.csv",
    ]:
        assert (out / name).read_bytes() == (DATASETS / name).read_bytes()
