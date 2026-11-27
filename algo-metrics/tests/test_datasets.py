"""合成评测集的字段、覆盖度与可复现性测试。"""

from __future__ import annotations

import csv
import hashlib
import json
import os
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


def _canonical_bytes(path):
    """取文件的**规范形态**（换行统一为 LF）。

    ``manifest.json`` 里的 sha256 记录的是仓库内的规范形态（LF）；仓库用
    ``.gitattributes`` 把 ``datasets/*.csv`` 钉成 ``text eol=lf`` 就是为了这件事。
    若检出时被本机换行策略（例如 Windows 的 ``core.autocrlf=true``）改写成 CRLF，
    直接对原始字节取哈希会与清单对不上——那是检出策略问题，不是数据变了。
    这里统一成 LF 再比较，让校验只针对**数据内容**，不受各平台换行策略影响。
    """
    return path.read_bytes().replace(b"\r\n", b"\n")


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
    assert MANIFEST["generated_at"]                     # 生成时间必填
    # 数据来源说明必须写明「合成/示意数据，不代表真实达成」
    assert "合成" in MANIFEST["disclaimer"]
    assert "不代表真实" in MANIFEST["disclaimer"]
    for name, meta in MANIFEST["files"].items():
        digest = hashlib.sha256(_canonical_bytes(DATASETS / name)).hexdigest()
        assert digest == meta["sha256"], name
        # 清单记录的行数必须与文件实际行数一致
        assert len(_rows(name)) == meta["rows"], name


def test_generator_is_reproducible(tmp_path):
    """同种子重跑，产出逐字节一致（换行按规范形态 LF 比较）。"""
    out = tmp_path / "regen"
    out.mkdir()
    # 子进程的输出按 UTF-8 解码：显式指定 PYTHONIOENCODING，
    # 否则 Windows 上子进程会按控制台代码页（GBK）输出，解码时报 UnicodeDecodeError。
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    result = subprocess.run(
        [sys.executable, str(DATASETS / "gen_datasets.py"), "--seed", "20261122",
         "--out", str(out)],
        capture_output=True, text=True, encoding="utf-8", env=env,
    )
    assert result.returncode == 0, result.stderr
    for name in [
        "parking_observations_sample.csv",
        "visitor_events_sample.csv",
        "route_impressions_sample.csv",
    ]:
        assert _canonical_bytes(out / name) == _canonical_bytes(DATASETS / name), name
