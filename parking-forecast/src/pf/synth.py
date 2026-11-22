"""合成数据生成器（完全可复现）。

- 单一 ``seed`` 决定全部随机性，统一使用 ``numpy.random.default_rng(seed)``，不混用全局 ``np.random``。
- 余位生成模型与缺失/过期注入顺序严格按 02 §3.3 / §3.4。
- 参数即契约：``SynthConfig`` 与 02 §3.2 表一致，全部写入 ``manifest.json``。
- 时区约定：合成数据固定使用 ``+08:00``（与 changdi-intake 北京口径一致），
  内部以 naive datetime 表示墙钟时间，输出时统一附加 ``+08:00``。
- ``generated_at`` 由参数给定（生成器不读系统时钟），缺省为 null，以保证逐字节可复现。
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from .schema import validate as schema_validate

GENERATOR_VERSION = "1.0.0"
TZ_OFFSET = "+08:00"
SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schemas"

_SCHEMA_CACHE: Dict[str, Dict[str, Any]] = {}


# --------------------------------------------------------------------------- #
# 默认配置（与 02 §3.2 一致；均为「示范」值，非真实事实）
# --------------------------------------------------------------------------- #
def _default_lots() -> List[Dict[str, Any]]:
    return [
        {
            "lot_id": "P1",
            "name": "沿江停车场",
            "total_spaces": 120,
            "base_occupancy": 0.72,
            "profile": "urban_core",
            "fee": {"mode": "hourly", "amount": 5.0, "unit": "CNY", "note": "5 元/小时（示范）"},
            "access": {
                "open_hours": "00:00-24:00",
                "one_way": False,
                "restricted_hours": [],
                "height_limit_m": None,
                "note": "沿江路单行道，需从水埠头方向进入（示范）",
            },
            "walk_to_street": {"meters": 150, "minutes": 2},
            "district": "长堤骑楼街",
            "geometry": None,
            "notes": "合成数据，仅用于管线验证",
            "source": "synthetic",
        },
        {
            "lot_id": "P2",
            "name": "内街停车场",
            "total_spaces": 80,
            "base_occupancy": 0.52,
            "profile": "urban_core",
            "fee": {"mode": "hourly", "amount": 4.0, "unit": "CNY", "note": "4 元/小时（示范）"},
            "access": {
                "open_hours": "06:00-24:00",
                "one_way": True,
                "restricted_hours": [{"from": "07:00", "to": "09:00", "note": "早高峰只出不进（示范）"}],
                "height_limit_m": 2.2,
                "note": "内街单行（示范）",
            },
            "walk_to_street": {"meters": 450, "minutes": 6},
            "district": "长堤骑楼街",
            "geometry": None,
            "notes": "合成数据，仅用于管线验证",
            "source": "synthetic",
        },
    ]


def _default_profile() -> Dict[str, Any]:
    # 日内形态控制点 [小时, 归一化强度]，线性插值，不硬编码具体街区规律。
    return {
        "urban_core": [
            [0.0, 0.05],
            [7.5, 0.20],
            [9.5, 1.00],
            [12.0, 0.65],
            [17.0, 0.95],
            [19.5, 1.00],
            [22.0, 0.55],
            [24.0, 0.05],
        ],
    }


def _default_day_type() -> Dict[str, Any]:
    return {
        "workday_shift": {"P1": 0.08, "P2": 0.05},
        "holiday_shift": {"P1": 0.15, "P2": 0.12},
        "weekend_shift": {"P1": 0.10, "P2": 0.08},
        "holidays": [],  # [{"date": "YYYY-MM-DD", "name": "..."}]
    }


def _default_peak() -> Dict[str, Any]:
    return {"intensity": {"P1": 0.18, "P2": 0.15}}


def _default_weather() -> Dict[str, Any]:
    return {
        "intensity": 1.0,  # weather_intensity 标量
        "block_hours": 6,   # 天气状态保持的小时数
        "distribution": {"sunny": 0.50, "cloudy": 0.30, "rain": 0.15, "heavy_rain": 0.04, "storm": 0.01},
        "coeff": {"sunny": 0.0, "cloudy": -0.02, "rain": -0.06, "heavy_rain": -0.10, "storm": -0.15},
        "temperature": {
            "sunny": [24.0, 32.0],
            "cloudy": [22.0, 28.0],
            "rain": [20.0, 25.0],
            "heavy_rain": [18.0, 23.0],
            "storm": [16.0, 20.0],
        },
    }


def _default_noise() -> Dict[str, Any]:
    return {"rho": 0.7, "sigma": 0.015}


@dataclass
class SynthConfig:
    """合成生成器参数（02 §3.2 表 + §3.4 的 suspect_rate）。"""

    seed: int
    start_date: str
    end_date: str
    granularity_minutes: int = 15
    lots: List[Dict[str, Any]] = field(default_factory=_default_lots)
    profile: Dict[str, Any] = field(default_factory=_default_profile)
    day_type: Dict[str, Any] = field(default_factory=_default_day_type)
    peak: Dict[str, Any] = field(default_factory=_default_peak)
    weather: Dict[str, Any] = field(default_factory=_default_weather)
    events: List[Dict[str, Any]] = field(default_factory=list)
    noise: Dict[str, Any] = field(default_factory=_default_noise)
    missing_rate: float = 0.03
    stale_rate: float = 0.02
    suspect_rate: float = 0.0
    outage_windows: List[Dict[str, str]] = field(default_factory=list)
    generated_at: Optional[str] = None


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _fmt(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S") + TZ_OFFSET


def _parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


def _parse_dt(s: str) -> datetime:
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError("无法解析时间 %r（期望 YYYY-MM-DDTHH:MM:SS，naive，按 +08:00 解释）" % s)


def _load_schema(name: str) -> Dict[str, Any]:
    if name not in _SCHEMA_CACHE:
        with open(SCHEMA_DIR / name, "r", encoding="utf-8") as f:
            _SCHEMA_CACHE[name] = json.load(f)
    return _SCHEMA_CACHE[name]


def _self_check(record: Dict[str, Any], schema_name: str) -> None:
    errors = schema_validate(record, _load_schema(schema_name))
    if errors:
        raise AssertionError("生成器产出非法 %s：%s" % (schema_name, errors))


def _per_lot(d: Dict[str, Any], key: str, lot_id: str) -> float:
    value = d.get(key)
    if isinstance(value, dict):
        return float(value.get(lot_id, value.get("default", 0.0)))
    return float(value)


def _interp(points: List[List[float]], hour: float) -> float:
    if hour <= points[0][0]:
        return float(points[0][1])
    if hour >= points[-1][0]:
        return float(points[-1][1])
    for i in range(len(points) - 1):
        h0, v0 = points[i]
        h1, v1 = points[i + 1]
        if h0 <= hour <= h1:
            if h1 == h0:
                return float(v0)
            frac = (hour - h0) / (h1 - h0)
            return float(v0 + frac * (v1 - v0))
    return float(points[-1][1])


def _is_weekend(t: datetime) -> bool:
    return t.weekday() >= 5


def _holidays_map(cfg: SynthConfig) -> Dict[str, str]:
    return {h["date"]: h.get("name", "") for h in cfg.day_type.get("holidays", [])}


def _calendar(t: datetime, holidays: Dict[str, str]):
    d = t.strftime("%Y-%m-%d")
    is_hol = d in holidays
    is_wknd = _is_weekend(t)
    is_work = (not is_wknd) and (not is_hol)
    return is_work, is_hol, is_wknd, (holidays[d] if is_hol else None)


def _peak_type(t: datetime) -> str:
    hm = t.hour + t.minute / 60.0
    if 7.5 <= hm < 9.5:
        return "am_peak"
    if 17.0 <= hm < 19.5:
        return "pm_peak"
    if 19.5 <= hm < 22.0:
        return "evening"
    return "none"


def _event_shape(t: datetime, ev: Dict[str, Any]) -> float:
    d = t.strftime("%Y-%m-%d")
    if d not in ev.get("dates", []):
        return 0.0
    start_h, end_h = ev["hours"]
    hm = t.hour + t.minute / 60.0
    if hm < start_h or hm > end_h:
        return 0.0
    ramp = 0.5  # 半小时渐入/渐出
    up = min(1.0, (hm - start_h) / ramp) if ramp > 0 else 1.0
    down = min(1.0, (end_h - hm) / ramp) if ramp > 0 else 1.0
    return float(max(0.0, min(up, down)))


# --------------------------------------------------------------------------- #
# AR(1) 噪声
# --------------------------------------------------------------------------- #
def ar1_noise(rng: np.random.Generator, n: int, rho: float, sigma: float) -> np.ndarray:
    """返回长度 ``n`` 的 AR(1) 序列：noise[0] ~ N(0, sigma)，noise[i] = rho*noise[i-1] + N(0, sigma)。"""
    noise = np.empty(max(0, n), dtype=float)
    if n == 0:
        return noise
    noise[0] = float(rng.normal(0.0, sigma))
    for i in range(1, n):
        noise[i] = rho * noise[i - 1] + float(rng.normal(0.0, sigma))
    return noise


# --------------------------------------------------------------------------- #
# 天气 / 时间轴
# --------------------------------------------------------------------------- #
def _build_timestamps(cfg: SynthConfig) -> List[datetime]:
    start = _parse_date(cfg.start_date)
    end = _parse_date(cfg.end_date)
    step = timedelta(minutes=cfg.granularity_minutes)
    n_days = (end - start).days + 1
    steps_per_day = 1440 // cfg.granularity_minutes
    return [start + i * step for i in range(n_days * steps_per_day)]


def _build_weather(rng: np.random.Generator, cfg: SynthConfig, timestamps: List[datetime]):
    n = len(timestamps)
    block_steps = max(1, (int(cfg.weather["block_hours"]) * 60) // cfg.granularity_minutes)
    names = list(cfg.weather["distribution"].keys())
    probs = np.array([cfg.weather["distribution"][k] for k in names], dtype=float)
    probs = probs / probs.sum()

    n_blocks = math.ceil(n / block_steps)
    block_names = rng.choice(np.array(names), size=n_blocks, p=probs).tolist()

    per_step: List[str] = []
    blocks: List[tuple] = []
    for b in range(n_blocks):
        name = block_names[b]
        lo, hi = cfg.weather["temperature"][name]
        temp = float(rng.uniform(lo, hi))
        blocks.append((timestamps[b * block_steps], name, temp))
        count = min(block_steps, n - b * block_steps)
        per_step.extend([name] * count)
    return per_step, blocks


# --------------------------------------------------------------------------- #
# 余位生成
# --------------------------------------------------------------------------- #
def _deterministic_occupancy(cfg: SynthConfig, lot: Dict[str, Any], t: datetime, cal, weather_name: str) -> float:
    is_work, is_hol, is_wknd, _holiday_name = cal
    lot_id = lot["lot_id"]

    occ = float(lot["base_occupancy"])
    occ += _per_lot(cfg.day_type, "workday_shift", lot_id) * (1.0 if is_work else 0.0)
    occ += _per_lot(cfg.day_type, "holiday_shift", lot_id) * (1.0 if is_hol else 0.0)
    occ -= _per_lot(cfg.day_type, "weekend_shift", lot_id) * (1.0 if is_wknd else 0.0)

    hour = t.hour + t.minute / 60.0
    peak_shape = _interp(cfg.profile[lot["profile"]], hour)
    occ += peak_shape * _per_lot(cfg.peak, "intensity", lot_id)

    occ += float(cfg.weather["coeff"].get(weather_name, 0.0)) * float(cfg.weather["intensity"])

    for ev in cfg.events:
        occ += float(ev.get("strength", 0.0)) * _event_shape(t, ev)

    return occ


def _obs_row(lot: Dict[str, Any], ts_str: str, free: Optional[int], total: int, quality: str,
             age: Optional[int]) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "lot_id": lot["lot_id"],
        "ts": ts_str,
        "free_spaces": free,
        "total_spaces": total,
        "source": "synthetic",
        "quality": quality,
    }
    if age is not None:
        record["age_seconds"] = age
    return record


def _outage_mask(cfg: SynthConfig, lot_id: str, timestamps: List[datetime]) -> List[bool]:
    mask = [False] * len(timestamps)
    for w in cfg.outage_windows:
        if w.get("lot_id") != lot_id:
            continue
        lo = _parse_dt(w["from"])
        hi = _parse_dt(w["to"])
        for i, ts in enumerate(timestamps):
            if lo <= ts <= hi:
                mask[i] = True
    return mask


def _inject(cfg: SynthConfig, rng: np.random.Generator, lot: Dict[str, Any],
            timestamps: List[datetime], true_free: List[int], outage: List[bool]) -> List[Dict[str, Any]]:
    """按 02 §3.4 顺序注入：outage → missing → stale（冻结）→ suspect。"""
    total = int(lot["total_spaces"])
    rows: List[Dict[str, Any]] = []
    last_valid: Optional[int] = None
    last_valid_ts: Optional[datetime] = None

    for i, t in enumerate(timestamps):
        ts_str = _fmt(t)

        if outage[i]:
            rows.append(_obs_row(lot, ts_str, None, total, "missing", None))
            continue

        if rng.random() < cfg.missing_rate:
            rows.append(_obs_row(lot, ts_str, None, total, "missing", None))
            continue

        if rng.random() < cfg.stale_rate:
            if last_valid is None:
                value = true_free[i]
                rows.append(_obs_row(lot, ts_str, value, total, "ok", None))
                last_valid = value
                last_valid_ts = t
            else:
                age = int((t - last_valid_ts).total_seconds())
                rows.append(_obs_row(lot, ts_str, last_valid, total, "stale", age))
            continue

        value = true_free[i]
        if rng.random() < cfg.suspect_rate:
            value = value + int(rng.choice([-1, 0, 1]))
            quality = "suspect"
        else:
            quality = "ok"
        rows.append(_obs_row(lot, ts_str, value, total, quality, None))
        last_valid = value
        last_valid_ts = t

    return rows


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
def _write_jsonl(path: Path, lines: List[Dict[str, Any]]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for rec in lines:
            f.write(json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n")


def _write_json(path: Path, obj: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, sort_keys=True, indent=2)
        f.write("\n")


def generate(cfg: SynthConfig, out_dir) -> Dict[str, Any]:
    """生成合成数据集到 ``out_dir``（lots/observations/signals.jsonl + manifest.json），返回 manifest。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(cfg.seed)
    timestamps = _build_timestamps(cfg)
    n = len(timestamps)
    holidays = _holidays_map(cfg)
    calendar = [_calendar(t, holidays) for t in timestamps]
    weather_per_step, weather_blocks = _build_weather(rng, cfg, timestamps)

    # ---- lots ----
    lot_lines: List[Dict[str, Any]] = []
    for lot in cfg.lots:
        record = {
            "lot_id": lot["lot_id"],
            "name": lot["name"],
            "total_spaces": int(lot["total_spaces"]),
            "fee": lot["fee"],
            "access": lot["access"],
            "geometry": lot.get("geometry"),
            "walk_to_street": lot["walk_to_street"],
            "district": lot.get("district"),
            "source": lot.get("source", "synthetic"),
            "notes": lot.get("notes"),
        }
        _self_check(record, "lot.schema.json")
        lot_lines.append(record)

    # ---- observations ----
    obs_lines: List[Dict[str, Any]] = []
    for lot in cfg.lots:
        noise = ar1_noise(rng, n, float(cfg.noise["rho"]), float(cfg.noise["sigma"]))
        total = int(lot["total_spaces"])
        true_free: List[int] = []
        for i, t in enumerate(timestamps):
            occ = _deterministic_occupancy(cfg, lot, t, calendar[i], weather_per_step[i])
            occ = float(np.clip(occ + noise[i], 0.02, 0.98))
            true_free.append(int(round(total * (1.0 - occ))))

        outage = _outage_mask(cfg, lot["lot_id"], timestamps)
        for o in _inject(cfg, rng, lot, timestamps, true_free, outage):
            _self_check(o, "observation.schema.json")
            obs_lines.append(o)

    # ---- signals ----
    sig_lines: List[Dict[str, Any]] = []
    for i, t in enumerate(timestamps):
        is_work, is_hol, _is_wknd, hol_name = calendar[i]
        record = {
            "lot_id": "ALL",
            "ts": _fmt(t),
            "kind": "calendar",
            "is_workday": is_work,
            "is_holiday": is_hol,
            "holiday_name": hol_name,
            "peak": _peak_type(t),
            "source": "synthetic",
        }
        _self_check(record, "signals.schema.json")
        sig_lines.append(record)

    for t, name, temp in weather_blocks:
        record = {
            "lot_id": "ALL",
            "ts": _fmt(t),
            "kind": "weather",
            "weather": name,
            "temperature_c": temp,
            "source": "synthetic",
        }
        _self_check(record, "signals.schema.json")
        sig_lines.append(record)

    for ev in cfg.events:
        for d in ev["dates"]:
            start_hour = ev["hours"][0]
            t = _parse_date(d) + timedelta(hours=start_hour)
            record = {
                "lot_id": "ALL",
                "ts": _fmt(t),
                "kind": "event",
                "event_id": ev["event_id"],
                "event_name": ev["name"],
                "event_strength": float(ev["strength"]),
                "source": "synthetic",
            }
            _self_check(record, "signals.schema.json")
            sig_lines.append(record)

    # ---- 写文件 ----
    files = {
        "lots.jsonl": lot_lines,
        "observations.jsonl": obs_lines,
        "signals.jsonl": sig_lines,
    }
    for fname, lines in files.items():
        _write_jsonl(out_dir / fname, lines)

    # ---- manifest ----
    file_sha256: Dict[str, str] = {}
    sample_counts: Dict[str, int] = {}
    for fname in files:
        data = (out_dir / fname).read_bytes()
        file_sha256[fname] = hashlib.sha256(data).hexdigest()
        sample_counts[fname] = len(files[fname])

    manifest = {
        "seed": cfg.seed,
        "generated_at": cfg.generated_at,
        "generator_version": GENERATOR_VERSION,
        "config": asdict(cfg),
        "file_sha256": file_sha256,
        "sample_counts": sample_counts,
    }
    _write_json(out_dir / "manifest.json", manifest)
    return manifest


# --------------------------------------------------------------------------- #
# 示范数据集入口
# --------------------------------------------------------------------------- #
def demo_config() -> SynthConfig:
    """固定参数的示范配置（含节假日/事件/断连窗口，用于产出 data/synthetic/）。"""
    cfg = SynthConfig(
        seed=42,
        start_date="2026-04-01",
        end_date="2026-04-14",
        generated_at="2026-04-15T00:00:00+08:00",
    )
    cfg.day_type["holidays"] = [{"date": "2026-04-06", "name": "示范节假日"}]
    cfg.events = [
        {
            "event_id": "EVT-DEMO-001",
            "name": "长堤夜市（示范）",
            "dates": ["2026-04-04", "2026-04-05"],
            "hours": [18.0, 22.0],
            "strength": 0.6,
        },
    ]
    cfg.outage_windows = [
        {"lot_id": "P1", "from": "2026-04-03T02:00:00", "to": "2026-04-03T04:00:00"},
    ]
    return cfg


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="生成合成停车数据集（可复现）")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "data" / "synthetic"))
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    cfg = demo_config()
    if args.seed is not None:
        cfg.seed = args.seed
    manifest = generate(cfg, args.out)
    print("wrote synthetic dataset to %s" % args.out)
    print("seed=%s generator_version=%s" % (cfg.seed, manifest["generator_version"]))
    print("sample_counts=%s" % manifest["sample_counts"])
