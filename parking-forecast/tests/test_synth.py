"""验收标准 1.2–1.9：可复现性、缺失/过期注入、outage、manifest、物理范围、AR(1) 自相关。

外加读取层 dataset 的排序去重测试。
"""

import hashlib
import json
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np  # noqa: E402

from pf.synth import SynthConfig, generate, ar1_noise  # noqa: E402
from pf.dataset import DatasetConfig, load_observations  # noqa: E402
from pf.schema import validate  # noqa: E402

SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schemas"
SCHEMA_FILES = ["lots.jsonl", "observations.jsonl", "signals.jsonl", "manifest.json"]


def _cfg(seed=0, days=5, **kw):
    return SynthConfig(seed=seed, start_date="2026-04-01", end_date="2026-04-%02d" % days, **kw)


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _read_jsonl(path):
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _parse_ts(s):
    return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")


# --------------------------------------------------------------------------- #
# 1.2 可复现：同 seed 同参数两次运行逐字节相同
# --------------------------------------------------------------------------- #
def test_reproducible_same_seed(tmp_path):
    d1, d2 = tmp_path / "a", tmp_path / "b"
    cfg1 = _cfg(seed=7, days=3)
    cfg2 = _cfg(seed=7, days=3)
    generate(cfg1, d1)
    generate(cfg2, d2)
    for name in SCHEMA_FILES:
        assert _sha(d1 / name) == _sha(d2 / name), name


# --------------------------------------------------------------------------- #
# 1.3 不同 seed 产出不同数据
# --------------------------------------------------------------------------- #
def test_different_seed_differs(tmp_path):
    d1, d2 = tmp_path / "a", tmp_path / "b"
    generate(_cfg(seed=1, days=3), d1)
    generate(_cfg(seed=2, days=3), d2)
    assert _sha(d1 / "observations.jsonl") != _sha(d2 / "observations.jsonl")


# --------------------------------------------------------------------------- #
# 1.4 缺失观测 free_spaces 是 null 而非 0
# --------------------------------------------------------------------------- #
def test_missing_free_spaces_is_null(tmp_path):
    out = tmp_path / "synthetic"
    generate(_cfg(seed=3, days=4, missing_rate=0.5, stale_rate=0.0), out)
    obs = _read_jsonl(out / "observations.jsonl")
    missing = [o for o in obs if o["quality"] == "missing"]
    assert missing, "应产生至少一条 missing 观测"
    for o in missing:
        assert o["free_spaces"] is None
        assert o["quality"] == "missing"


# --------------------------------------------------------------------------- #
# 1.5 过期观测带 age_seconds 且随冻结时长单调不减
# --------------------------------------------------------------------------- #
def _stale_runs(obs):
    """按时间序切出连续 stale 段（ok/suspect 打断，missing 不打断冻结）。"""
    obs = sorted(obs, key=lambda o: _parse_ts(o["ts"]))
    runs, cur = [], []
    for o in obs:
        q = o["quality"]
        if q == "stale":
            cur.append(o["age_seconds"])
        elif q in ("ok", "suspect"):
            if cur:
                runs.append(cur)
                cur = []
    if cur:
        runs.append(cur)
    return runs


def test_stale_age_seconds_monotonic(tmp_path):
    out = tmp_path / "synthetic"
    generate(_cfg(seed=4, days=5, missing_rate=0.0, stale_rate=0.3), out)
    obs = _read_jsonl(out / "observations.jsonl")
    lot_ids = sorted({o["lot_id"] for o in obs})
    any_run_len2 = False
    for lot_id in lot_ids:
        for run in _stale_runs([o for o in obs if o["lot_id"] == lot_id]):
            if len(run) >= 2:
                any_run_len2 = True
            assert all(run[i] <= run[i + 1] for i in range(len(run) - 1)), run
    assert any_run_len2, "应存在至少一段连续 ≥2 的 stale 冻结"


# --------------------------------------------------------------------------- #
# 1.6 outage_windows 区间全部为 missing
# --------------------------------------------------------------------------- #
def test_outage_window_all_missing(tmp_path):
    out = tmp_path / "synthetic"
    lo, hi = "2026-04-02T08:00:00", "2026-04-02T10:00:00"
    generate(_cfg(seed=5, days=3, missing_rate=0.0, stale_rate=0.0,
                  outage_windows=[{"lot_id": "P1", "from": lo, "to": hi}]), out)
    obs = _read_jsonl(out / "observations.jsonl")
    lo_dt, hi_dt = _parse_ts(lo), _parse_ts(hi)
    in_window = [o for o in obs if o["lot_id"] == "P1" and lo_dt <= _parse_ts(o["ts"]) <= hi_dt]
    assert in_window, "outage 窗口内应存在观测"
    for o in in_window:
        assert o["quality"] == "missing"
        assert o["free_spaces"] is None


# --------------------------------------------------------------------------- #
# 1.7 manifest 记录 seed、完整参数、sha256、样本计数
# --------------------------------------------------------------------------- #
def test_manifest_records_seed_params_sha_counts(tmp_path):
    out = tmp_path / "synthetic"
    cfg = _cfg(seed=6, days=3)
    manifest = generate(cfg, out)

    assert manifest["seed"] == 6
    assert manifest["generator_version"]

    expected_params = {
        "seed", "start_date", "end_date", "granularity_minutes", "lots", "profile",
        "day_type", "peak", "weather", "events", "noise", "missing_rate", "stale_rate",
        "suspect_rate", "outage_windows",
    }
    assert expected_params <= set(manifest["config"].keys())

    for name in ["lots.jsonl", "observations.jsonl", "signals.jsonl"]:
        assert name in manifest["file_sha256"]
        assert name in manifest["sample_counts"]
        assert manifest["file_sha256"][name] == _sha(out / name)
        assert manifest["sample_counts"][name] == len(_read_jsonl(out / name))


# --------------------------------------------------------------------------- #
# 1.8 物理合理范围：余位 ∈ [0, total]，空置率 ∈ [0, 1]
# --------------------------------------------------------------------------- #
def test_physical_range(tmp_path):
    out = tmp_path / "synthetic"
    generate(_cfg(seed=8, days=5, missing_rate=0.0, stale_rate=0.0, suspect_rate=0.0), out)
    lots = {l["lot_id"]: l["total_spaces"] for l in _read_jsonl(out / "lots.jsonl")}
    obs = _read_jsonl(out / "observations.jsonl")
    assert obs
    for o in obs:
        if o["free_spaces"] is not None:
            total = lots[o["lot_id"]]
            assert 0 <= o["free_spaces"] <= total
            rate = o["free_spaces"] / total
            assert 0.0 <= rate <= 1.0


# --------------------------------------------------------------------------- #
# 1.9 AR(1) 噪声 lag-1 自相关 |rho| > 0.5
# --------------------------------------------------------------------------- #
def test_ar1_noise_autocorrelation():
    rng = np.random.default_rng(123)
    x = ar1_noise(rng, 2000, 0.7, 0.015)
    r = np.corrcoef(x[:-1], x[1:])[0, 1]
    assert abs(r) > 0.5, "lag-1 自相关应接近 0.7，实际 %r" % r


# --------------------------------------------------------------------------- #
# 生成器自检：所有产物行都能通过对应 schema
# --------------------------------------------------------------------------- #
def test_generated_output_schema_valid(tmp_path):
    out = tmp_path / "synthetic"
    generate(_cfg(seed=9, days=3), out)

    schemas = {
        "lots.jsonl": "lot.schema.json",
        "observations.jsonl": "observation.schema.json",
        "signals.jsonl": "signals.schema.json",
    }
    for name, schema_name in schemas.items():
        schema = json.loads((SCHEMA_DIR / schema_name).read_text(encoding="utf-8"))
        for rec in _read_jsonl(out / name):
            assert validate(rec, schema) == [], (name, rec)


# --------------------------------------------------------------------------- #
# dataset：排序 + 去重（保留 quality 最高）
# --------------------------------------------------------------------------- #
def test_dataset_dedup_sorts(tmp_path):
    d = tmp_path / "synthetic"
    d.mkdir()
    (d / "lots.jsonl").write_text("", encoding="utf-8")
    (d / "signals.jsonl").write_text("", encoding="utf-8")

    obs = [
        {"lot_id": "P2", "ts": "2026-04-01T08:00:00+08:00", "free_spaces": 10, "source": "synthetic",
         "quality": "stale", "age_seconds": 300},
        {"lot_id": "P1", "ts": "2026-04-01T08:00:00+08:00", "free_spaces": 20, "source": "synthetic", "quality": "ok"},
        {"lot_id": "P1", "ts": "2026-04-01T07:00:00+08:00", "free_spaces": 5, "source": "synthetic", "quality": "ok"},
        {"lot_id": "P1", "ts": "2026-04-01T08:00:00+08:00", "free_spaces": None, "source": "synthetic", "quality": "missing"},
    ]
    (d / "observations.jsonl").write_text(
        "\n".join(json.dumps(o, ensure_ascii=False) for o in obs) + "\n", encoding="utf-8")

    ds = load_observations(DatasetConfig(source="synthetic", data_dir=str(d)))
    assert [o["lot_id"] for o in ds.observations] == ["P1", "P1", "P2"]
    assert ds.observations[1]["quality"] == "ok"
    assert ds.observations[1]["free_spaces"] == 20


def test_dataset_real_branch_is_stub():
    try:
        load_observations(DatasetConfig(source="real", data_dir="."))
    except NotImplementedError:
        pass
    else:
        raise AssertionError("真实分支应留接口桩并抛 NotImplementedError")
