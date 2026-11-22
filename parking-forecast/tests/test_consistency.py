"""阶段 2 验收 2.17 / 2.25：生成 500 条 Python 输出作为黄金基准，供 node:test 逐位比对。

运行：``python -m pytest tests/test_consistency.py -q``
产物：``artifacts/model.json``（确定性重写）+ ``runtime/test/fixtures/consistency.json``。
2.25 断言：model.json 含 ranking_caps / ranking_weights，可复算历史推荐。
"""

import json
import random
import sys
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from pf.dataset import DatasetConfig, load_observations  # noqa: E402
from pf.features import (  # noqa: E402
    FEATURE_NAMES, HORIZONS, MINUTES_PER_SLOT, build_lot_features, compute_feature_stats,
    fmt_ts, prepare,
)
from pf.backtest import TrainRange, time_split  # noqa: E402
from pf import train as T  # noqa: E402
from pf.export import build_model_artifact, data_fingerprint, write_json  # noqa: E402
from pf.recommend import recommend, RANKING_CAPS, RANKING_WEIGHTS  # noqa: E402

DATA_DIR = ROOT / "data" / "synthetic"
ARTIFACT_DIR = ROOT / "artifacts"
FIXTURE_PATH = ROOT / "runtime" / "test" / "fixtures" / "consistency.json"

N_CASES = 500
N_RECOMMEND = 20


def _unnest(a):
    """把 model.json 产物还原成 train 模块的模型 dict（Python 侧预测用同一份数值）。"""
    return {
        "version": a["version"], "kind": a["kind"], "feature_names": a["features"],
        "scaler": a["payload"]["scaler"], "horizons": a["payload"]["horizons"],
        "residual_quantiles": a["payload"]["residual_quantiles"],
        "feature_fills": a["payload"]["feature_fills"],
        "calendar": a["payload"]["calendar"],
    }


def _build():
    ds = load_observations(DatasetConfig(source="synthetic", data_dir=str(DATA_DIR)))
    manifest = json.loads((DATA_DIR / "manifest.json").read_text(encoding="utf-8"))
    fingerprint = data_fingerprint(manifest)
    prepared = prepare(ds)
    lot_ids = list(prepared.lots.keys())
    min_ts = min(prepared.obs_by_lot[l][0][0] for l in lot_ids)
    max_ts = max(prepared.obs_by_lot[l][0][-1] for l in lot_ids)
    split = time_split(min_ts, max_ts)
    final_tr = TrainRange(min_ts, split.test_start - timedelta(seconds=1))
    stats = compute_feature_stats(ds, final_tr)
    final_model = T.train_linear_model(ds, final_tr, stats)
    trained_at = manifest.get("generated_at") or "2026-04-15T00:00:00+08:00"
    artifact = build_model_artifact(final_model, ds.lots, trained_at, fingerprint, source="synthetic")
    write_json(ARTIFACT_DIR / "model.json", artifact)
    return ds, prepared, lot_ids, min_ts, max_ts, artifact, fingerprint


def test_artifact_has_ranking_caps_and_weights():
    """2.25：归一化上限与权重写进 model.json，可复算历史推荐。"""
    ds, prepared, lot_ids, min_ts, max_ts, artifact, fingerprint = _build()
    assert artifact["ranking_caps"] == RANKING_CAPS
    assert artifact["ranking_weights"] == RANKING_WEIGHTS
    assert artifact["kind"] == "linear"
    assert artifact["features"] == list(FEATURE_NAMES)
    assert artifact["source"] == "synthetic"
    assert set(artifact["payload"]["horizons"].keys()) == {"15", "30", "45", "60"}


def test_generate_consistency_fixture():
    """2.17：写出 500 条 Python 黄金基准（features + forecasts + 20 条 recommend）。"""
    ds, prepared, lot_ids, min_ts, max_ts, artifact, fingerprint = _build()
    model = _unnest(artifact)
    step = timedelta(minutes=MINUTES_PER_SLOT)
    total_slots = int((max_ts - min_ts).total_seconds() // (60 * MINUTES_PER_SLOT))
    rng = random.Random(12345)

    cases = []
    for i in range(N_CASES):
        lot_id = lot_ids[i % len(lot_ids)]
        if i < 10:
            # 首条观测之前 → 触发 D4（unavailable）
            issued = min_ts - timedelta(minutes=60 + 15 * i)
            cutoff = issued
        else:
            issued = min_ts + step * rng.randint(0, total_slots)
            mode = i % 10
            cutoff = issued - timedelta(hours=1) if mode == 0 else (
                issued - timedelta(hours=3) if mode == 1 else issued)
        f = build_lot_features(ds, lot_id, issued, cutoff, stats=model["feature_fills"])
        forecasts, _ = T.forecast_lot(ds, model, lot_id, issued, cutoff,
                                      horizons=HORIZONS, stats=model["feature_fills"])
        cases.append({
            "lot_id": lot_id,
            "issued_at": fmt_ts(issued),
            "cutoff": fmt_ts(cutoff),
            "features": {n: f.values[n] for n in FEATURE_NAMES},
            "forecasts": forecasts,
        })

    recs = []
    prefs = ["default", "save_time", "less_walking"]
    rng2 = random.Random(777)
    for i in range(N_RECOMMEND):
        issued = min_ts + step * rng2.randint(0, total_slots)
        arrive = issued + timedelta(minutes=30)
        pref = prefs[i % 3]
        vehicle = None if i % 2 == 0 else {"height_m": 1.9}
        r = recommend(ds, model, "DEST-DEMO-001", arrive, preference=pref,
                      vehicle=vehicle, travel_mode="drive", generated_at=issued)
        recs.append({
            "issued_at": fmt_ts(issued),
            "arrive_at": fmt_ts(arrive),
            "preference": pref,
            "vehicle": vehicle,
            "recommend": r,
        })

    fixture = {
        "source": "synthetic",
        "generated_by": "tests/test_consistency.py",
        "n_cases": len(cases),
        "n_recommend": len(recs),
        "data_fingerprint": fingerprint,
        "cases": cases,
        "recommend_cases": recs,
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n"：夹具也是生成物，一律 LF 落盘（与 pf.export.write_json 同一策略）。
    FIXTURE_PATH.write_text(json.dumps(fixture, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
    assert len(cases) == N_CASES
    assert len(recs) == N_RECOMMEND
