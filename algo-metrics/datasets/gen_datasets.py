"""合成评测集生成器（algo-metrics / 任务 M4）。

用法::

    python algo-metrics/datasets/gen_datasets.py            # 默认种子 20261122
    python algo-metrics/datasets/gen_datasets.py --seed 7   # 换种子重生成

产出三个 CSV + ``manifest.json``（含种子、参数、行数、sha256、生成规则摘要）。
**全部为合成数据（data_source=synthetic / verified=false）**，只用于验证评测链路，
不代表真实业务水平。真实数据到位后**只换数据文件、不改算法**（口径见
``docs/metrics-definition.md`` 第 0 节）。

生成规则（与 manifest.json 一一对应）：

1. 时间：2026-10-01 ~ 2026-10-14，业务时区 +08:00，停车时序 30 分钟粒度。
   前 4 天（10-01~10-04）为**预热段**，只用于预测器的历史统计；
   后 10 天（10-05~10-14）为**评估段**（CSV 里用 ``split`` 列区分）。
2. 车场：PK001=100 位、PK002=120 位、PK003=80 位。
3. 余位真值：占用率模型（工作日/节假日/周末/高峰/天气/活动/AR(1) 噪声），
   free = round(total × (1 − occupancy))。
4. 缺值注入（顺序固定）：① 整段 outage → ② 随机 missing → ③ 随机 stale（冻结上一有效值）。
5. 预测值（参考预测器，供评测集自带对照）：预测目标时刻 = 行 ts，
   预测由 ts−60min 的信息生成（last_known + 同星期同时段中位数 + 车场基础空置率）。
6. 事件流：120 个匿名访客，随机生成 view/adopt/finish 等事件，
   路线完成率目标 45%、点击出发率 55%、错峰建议采纳率 30%（均为生成参数，不是真实结论）。
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
DEFAULT_SEED = 20261122

START = datetime(2026, 10, 1)
DAYS = 14
SLOT_MINUTES = 30
SLOTS_PER_DAY = 48
HORIZON_MINUTES = 60
WARMUP_DAYS = 4

LOTS: List[Tuple[str, int, float, float, float, float]] = [
    # (parking_id, total_spaces, base_occupancy, workday_shift, holiday_shift, weekend_shift)
    ("PK001", 100, 0.42, 0.12, 0.18, 0.10),
    ("PK002", 120, 0.38, 0.10, 0.16, 0.08),
    ("PK003", 80, 0.46, 0.14, 0.20, 0.12),
]

WEATHER_BY_DAY = [
    "sunny", "sunny", "cloudy", "rain", "cloudy", "sunny", "heavy_rain",
    "cloudy", "sunny", "sunny", "rain", "cloudy", "sunny", "sunny",
]
WEATHER_COEFF = {"sunny": 0.0, "cloudy": 0.03, "rain": 0.08, "heavy_rain": 0.14}
HOLIDAY_DATES = {  # 2026 国庆假期示例
    "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    "2026-10-05", "2026-10-06", "2026-10-07",
}
EVENT_DATES = {"2026-10-03", "2026-10-04", "2026-10-10", "2026-10-11"}
POINT_IDS = ["LD%03d" % i for i in range(1, 13)]
INTEREST_POOL = ["历史", "建筑", "美食", "非遗", "侨乡", "自然", "亲子", "摄影"]
DEVICE_LANGS = ["zh-Hans", "zh-Hans", "yue-Hant", "yue-Hant", "en"]


def iso(dt: datetime) -> str:
    """输出契约 §2 要求的带时区 ISO 8601（+08:00）。"""
    return dt.strftime("%Y-%m-%dT%H:%M:%S+08:00")


def peak_shape(dt: datetime) -> float:
    """高峰形状：早高峰 07:30–09:30、晚高峰 17:00–19:30，梯形过渡。"""
    minutes = dt.hour * 60 + dt.minute
    if 7 * 60 + 30 <= minutes <= 9 * 60 + 30:
        return 1.0
    if 17 * 60 <= minutes <= 19 * 60 + 30:
        return 0.85
    if 6 * 60 + 30 <= minutes < 7 * 60 + 30:
        return (minutes - (6 * 60 + 30)) / 60.0
    if 9 * 60 + 30 < minutes <= 10 * 60 + 30:
        return max(0.0, 1.0 - (minutes - (9 * 60 + 30)) / 60.0)
    if 16 * 60 <= minutes < 17 * 60:
        return (minutes - (16 * 60)) / 60.0
    if 19 * 60 + 30 < minutes <= 20 * 60 + 30:
        return max(0.0, 0.85 - (minutes - (19 * 60 + 30)) / 60.0)
    return 0.0


def build_parking_rows(rng: random.Random) -> List[Dict[str, object]]:
    """生成停车观测评测集（含缺值桶与参考预测值）。"""
    rows: List[Dict[str, object]] = []
    # 1) 真值序列（先算真值，再注入缺失）
    truth: Dict[str, Dict[str, float]] = {}
    for parking_id, total, base, workday, holiday, weekend in LOTS:
        series: Dict[str, float] = {}
        noise = 0.0
        for day in range(DAYS):
            day_date = START + timedelta(days=day)
            date_str = day_date.strftime("%Y-%m-%d")
            is_holiday = 1 if date_str in HOLIDAY_DATES else 0
            is_weekend = 1 if day_date.weekday() >= 5 else 0
            weather = WEATHER_BY_DAY[day]
            has_event = 1 if date_str in EVENT_DATES else 0
            for slot in range(SLOTS_PER_DAY):
                ts = day_date + timedelta(minutes=slot * SLOT_MINUTES)
                noise = 0.7 * noise + rng.gauss(0.0, 0.015)
                occupancy = (
                    base
                    + workday * (0 if is_weekend else 1)
                    + holiday * is_holiday
                    - weekend * is_weekend
                    + 0.22 * peak_shape(ts)
                    + WEATHER_COEFF[weather]
                    + (0.10 * peak_shape(ts) if has_event else 0.0)
                    + noise
                )
                occupancy = min(0.95, max(0.05, occupancy))
                free = int(round(total * (1.0 - occupancy)))
                free = max(0, min(total, free))
                series[iso(ts)] = float(free)
        truth[parking_id] = series

    # 2) 缺值注入：outage 窗口 → 随机 missing → 随机 stale
    outage = {  # (parking_id, 起, 止)
        ("PK002", "2026-10-08 02:00", "2026-10-08 05:00"),
        ("PK003", "2026-10-12 13:00", "2026-10-12 13:30"),
    }
    for parking_id, total, _base, _w, _h, _e in LOTS:
        series = truth[parking_id]
        keys = sorted(series)
        last_ok: Optional[float] = None
        emitted: Dict[str, float] = {}  # 已落盘的 quality=ok 桶：ts → free
        for ts_str in keys:
            ts = datetime.strptime(ts_str[:19], "%Y-%m-%dT%H:%M:%S")
            date_str = ts.strftime("%Y-%m-%d")
            value = int(series[ts_str])
            quality = "ok"
            age_seconds: Optional[int] = None
            free_out: Optional[int] = value

            in_outage = any(
                pid == parking_id and start <= ts.strftime("%Y-%m-%d %H:%M") <= end
                for pid, start, end in outage
            )
            if in_outage or rng.random() < 0.02:
                quality = "missing"
                free_out = None
                age_seconds = None
            elif rng.random() < 0.03 and last_ok is not None:
                quality = "stale"
                age_seconds = rng.choice([300, 600, 900, 1800, 3600])
                free_out = int(last_ok)
            else:
                last_ok = value

            # 3) 参考预测（目标 = 本行 ts，信息截止 ts−60min，只用已落盘的 ok 桶）
            pred_ts = ts - timedelta(minutes=HORIZON_MINUTES)
            predicted = predict_free(emitted, total, pred_ts)

            occupied = None if free_out is None else total - free_out
            if quality == "ok":
                emitted[ts_str] = float(free_out)
            rows.append(
                {
                    "parking_id": parking_id,
                    "ts": ts_str,
                    "occupied_spaces": "" if occupied is None else occupied,
                    "free_spaces": "" if free_out is None else free_out,
                    "total_spaces": total,
                    "weekday": ts.weekday(),
                    "is_holiday": 1 if date_str in HOLIDAY_DATES else 0,
                    "weather": WEATHER_BY_DAY[(ts - START).days],
                    "event_flag": 1 if date_str in EVENT_DATES else 0,
                    "data_source": "synthetic",
                    "quality": quality,
                    "age_seconds": "" if age_seconds is None else age_seconds,
                    "predicted_free_spaces": "" if predicted is None else predicted,
                    "horizon_min": HORIZON_MINUTES,
                    "split": "warmup" if (ts - START).days < WARMUP_DAYS else "eval",
                }
            )
    rows.sort(key=lambda r: (r["parking_id"], r["ts"]))
    return rows


def predict_free(
    emitted: Dict[str, float],
    total: int,
    pred_ts: datetime,
) -> Optional[int]:
    """参考预测器（合成数据自带的对照模型，口径写进 README）。

    预测目标时刻 = 行 ts；可用信息截止 ts−60min，且只用已落盘的 quality=ok 桶：
    last_known（ts−60min 之前最近一条有效值）+ 同星期同时段历史中位数 + 车场基础空置率。
    """
    last_known: Optional[float] = None
    last_known_ts: Optional[datetime] = None
    same_slot: List[float] = []
    warmup_values: List[float] = []
    target_time = pred_ts.strftime("%H:%M")
    for ts_str, free in emitted.items():
        moment = datetime.strptime(ts_str[:19], "%Y-%m-%dT%H:%M:%S")
        if moment > pred_ts:
            continue
        if last_known_ts is None or moment > last_known_ts:
            last_known = free
            last_known_ts = moment
        if moment.strftime("%H:%M") == target_time and (pred_ts - moment).days <= 7:
            same_slot.append(free)
        if moment.date() <= (START + timedelta(days=7)).date():
            warmup_values.append(free)

    if last_known is None:
        return None
    same_slot_median = sorted(same_slot)[len(same_slot) // 2] if same_slot else last_known
    base_ratio = (sum(warmup_values) / len(warmup_values) / total) if warmup_values else 0.5

    predicted = (
        0.50 * last_known + 0.30 * same_slot_median + 0.20 * base_ratio * total
    )
    return int(max(0, min(total, round(predicted))))


def build_visitor_events(rng: random.Random) -> List[Dict[str, object]]:
    """生成游客行为事件流（契约 §4.5 字段 + data_source）。"""
    rows: List[Dict[str, object]] = []
    visitors = 120
    for v in range(1, visitors + 1):
        visitor_id = "V%04d" % v
        day = rng.randrange(WARMUP_DAYS, DAYS)
        hour = rng.choice([9, 10, 11, 13, 14, 15, 16, 17, 18, 19])
        minute = rng.choice([0, 10, 20, 30, 45])
        ts = START + timedelta(days=day, hours=hour, minutes=minute)
        lang = rng.choice(DEVICE_LANGS)
        tags = rng.sample(INTEREST_POOL, rng.randint(1, 3))
        tags_str = json.dumps(tags, ensure_ascii=False)

        n_routes = rng.choice([0, 1, 1, 1, 2, 3])
        for r in range(n_routes):
            route_id = "R%04d" % (v * 10 + r)
            route_ts = ts + timedelta(minutes=rng.randint(0, 40))
            rows.append(_event(visitor_id, route_ts, "view_route", "", route_id, rng, tags_str, lang))
            points = rng.sample(POINT_IDS, rng.randint(2, 4))
            if rng.random() < 0.55:
                rows.append(
                    _event(visitor_id, route_ts + timedelta(minutes=1), "adopt_route", "", route_id,
                           rng, tags_str, lang)
                )
            if rng.random() < 0.45:  # 生成参数：路线完成率 45%
                finish_ts = route_ts + timedelta(minutes=rng.randint(20, 240))
                rows.append(
                    _event(visitor_id, finish_ts, "finish_route", "", route_id, rng, tags_str, lang)
                )
                for point in points:
                    rows.append(
                        _event(visitor_id, finish_ts + timedelta(minutes=rng.randint(1, 12)),
                               "arrive_point", point, route_id, rng, tags_str, lang)
                    )
                    if rng.random() < 0.4:
                        rows.append(
                            _event(visitor_id, finish_ts + timedelta(minutes=2), "listen_guide",
                                   point, route_id, rng, tags_str, lang)
                        )
                    if rng.random() < 0.12:
                        rows.append(
                            _event(visitor_id, finish_ts + timedelta(minutes=3), "ask_question",
                                   point, route_id, rng, tags_str, lang)
                        )

        if rng.random() < 0.55:
            parking_ts = ts + timedelta(minutes=rng.randint(0, 90))
            rows.append(_event(visitor_id, parking_ts, "view_parking", "", "", rng, tags_str, lang))
            if rng.random() < 0.30:  # 生成参数：错峰建议采纳率 30%
                rows.append(
                    _event(visitor_id, parking_ts + timedelta(minutes=rng.randint(1, 20)),
                           "adopt_parking", "", "", rng, tags_str, lang)
                )
        if rng.random() < 0.28:
            rows.append(
                _event(visitor_id, ts + timedelta(minutes=rng.randint(30, 180)), "book_guide",
                       rng.choice(POINT_IDS), "", rng, tags_str, lang)
            )
        if rng.random() < 0.18:
            rows.append(
                _event(visitor_id, ts + timedelta(minutes=rng.randint(60, 300)), "feedback",
                       rng.choice(POINT_IDS), "", rng, tags_str, lang)
            )
    rows.sort(key=lambda r: (r["ts"], r["visitor_id"]))
    return rows


def _event(
    visitor_id: str,
    ts: datetime,
    event_type: str,
    point_id: str,
    route_id: str,
    rng: random.Random,
    tags_str: str,
    lang: str,
) -> Dict[str, object]:
    """构造一条事件（缺失值按契约留空，不填 0）。"""
    dwell: object = ""
    if event_type in ("arrive_point", "listen_guide", "ask_question"):
        dwell = rng.randint(30, 900)
    elif event_type == "view_route":
        dwell = rng.randint(5, 120)
    elif event_type == "finish_route":
        dwell = rng.randint(600, 5400)
    elif event_type == "feedback":
        dwell = rng.randint(10, 60)
    empty_tags = rng.random() < 0.08
    return {
        "visitor_id": visitor_id,
        "ts": iso(ts),
        "event_type": event_type,
        "point_id": point_id,
        "route_id": route_id,
        "dwell_seconds": dwell,
        "interest_tags": "" if empty_tags else tags_str,
        "device_lang": lang,
        "data_source": "synthetic",
    }


def build_route_impressions(rng: random.Random) -> List[Dict[str, object]]:
    """生成路线曝光明细（离线代理指标的数据源）。"""
    rows: List[Dict[str, object]] = []
    for i in range(240):
        visitor_id = "V%04d" % rng.randint(1, 120)
        day = rng.randrange(WARMUP_DAYS, DAYS)
        ts = START + timedelta(days=day, hours=rng.choice(range(8, 20)), minutes=rng.choice([0, 15, 30, 45]))
        side_focus = rng.choice(["culture", "distance", "depth"])
        points = "|".join(rng.sample(POINT_IDS, rng.randint(2, 4)))
        adopted = 1 if rng.random() < 0.45 else 0  # 生成参数：曝光采纳率 45%
        dwell = rng.randint(8, 300) if adopted else rng.randint(1, 40)
        rows.append(
            {
                "impression_id": "IMP%05d" % (i + 1),
                "visitor_id": visitor_id,
                "ts": iso(ts),
                "algo_version": "route-recommender-0.1.0",
                "side_focus": side_focus,
                "shown_point_ids": points,
                "adopted": adopted,
                "dwell_seconds": dwell,
                "data_source": "synthetic",
            }
        )
    rows.sort(key=lambda r: r["ts"])
    return rows


def write_csv(path: Path, rows: List[Dict[str, object]], fieldnames: Sequence[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(fieldnames), lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="生成 algo-metrics 合成评测集")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="随机种子")
    parser.add_argument("--out", type=str, default=str(HERE), help="输出目录")
    args = parser.parse_args(argv)

    rng = random.Random(args.seed)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    parking = build_parking_rows(rng)
    events = build_visitor_events(rng)
    impressions = build_route_impressions(rng)

    parking_fields = [
        "parking_id", "ts", "occupied_spaces", "free_spaces", "total_spaces", "weekday",
        "is_holiday", "weather", "event_flag", "data_source", "quality", "age_seconds",
        "predicted_free_spaces", "horizon_min", "split",
    ]
    event_fields = [
        "visitor_id", "ts", "event_type", "point_id", "route_id", "dwell_seconds",
        "interest_tags", "device_lang", "data_source",
    ]
    impression_fields = [
        "impression_id", "visitor_id", "ts", "algo_version", "side_focus", "shown_point_ids",
        "adopted", "dwell_seconds", "data_source",
    ]

    parking_path = out_dir / "parking_observations_sample.csv"
    events_path = out_dir / "visitor_events_sample.csv"
    impressions_path = out_dir / "route_impressions_sample.csv"
    write_csv(parking_path, parking, parking_fields)
    write_csv(events_path, events, event_fields)
    write_csv(impressions_path, impressions, impression_fields)

    quality_counts: Dict[str, int] = {}
    for row in parking:
        quality_counts[str(row["quality"])] = quality_counts.get(str(row["quality"]), 0) + 1

    manifest = {
        "data_source": "synthetic",
        "verified": False,
        "seed": args.seed,
        "generator": "algo-metrics/datasets/gen_datasets.py",
        "command": "python algo-metrics/datasets/gen_datasets.py --seed %d" % args.seed,
        "generated_at": iso(datetime(2026, 11, 22, 9, 0)),
        "period": {
            "start": iso(START),
            "end": iso(START + timedelta(days=DAYS - 1, hours=23, minutes=30)),
            "timezone": "+08:00",
            "granularity_minutes": SLOT_MINUTES,
            "warmup_days": WARMUP_DAYS,
        },
        "files": {
            "parking_observations_sample.csv": {
                "rows": len(parking),
                "sha256": sha256(parking_path),
                "quality_counts": quality_counts,
            },
            "visitor_events_sample.csv": {"rows": len(events), "sha256": sha256(events_path)},
            "route_impressions_sample.csv": {
                "rows": len(impressions),
                "sha256": sha256(impressions_path),
            },
        },
        "parameters": {
            "lots": [
                {"parking_id": p, "total_spaces": t, "base_occupancy": b,
                 "workday_shift": w, "holiday_shift": h, "weekend_shift": e}
                for p, t, b, w, h, e in LOTS
            ],
            "horizon_minutes": HORIZON_MINUTES,
            "missing_rate": 0.02,
            "stale_rate": 0.03,
            "outage_windows": ["PK002 2026-10-08 02:00~05:00", "PK003 2026-10-12 13:00~13:30"],
            "holiday_dates": sorted(HOLIDAY_DATES),
            "event_dates": sorted(EVENT_DATES),
            "weather_by_day": WEATHER_BY_DAY,
            "route_finish_rate": 0.45,
            "route_adopt_click_rate": 0.55,
            "offpeak_adoption_rate": 0.30,
            "impression_adoption_rate": 0.45,
            "visitor_count": 120,
        },
        "disclaimer": (
            "本目录全部为合成/示意数据（data_source=synthetic，verified=false），"
            "只用于验证评测链路与口径计算，不代表真实达成，也不代表任何真实业务水平；"
            "真实数据到位后只替换数据文件，不改算法与口径。"
        ),
        "synthetic_note": (
            "合成/示意数据，不代表真实达成：本清单里的 seed / sha256 只保证"
            "「同一份生成器 + 同一个种子 → 同一份数据」的可复现性，"
            "由它算出的指标数值不构成任何达标结论；需求方书面确认放在上线阶段。"
        ),
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print("生成完成（seed=%d）：" % args.seed)
    for name, meta in manifest["files"].items():
        print("  %-36s rows=%-6d sha256=%s" % (name, meta["rows"], meta["sha256"][:16]))
    print("  manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
