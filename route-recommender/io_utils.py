"""UTF-8 data I/O and validation for the route data contract."""

import csv
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

BEIJING = timezone(timedelta(hours=8))
INTEREST_TAGS = frozenset(("历史", "建筑", "美食", "非遗", "侨乡", "自然", "亲子", "摄影"))
CATEGORIES = frozenset(("历史建筑", "文化场馆", "非遗业态", "餐饮", "商业", "公共服务", "停车场", "街景节点"))
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
EVENT_COLUMNS = (
    "visitor_id", "ts", "event_type", "point_id", "route_id", "dwell_seconds", "interest_tags",
    "device_lang",
)
EVENT_TYPES = frozenset((
    "view_route", "adopt_route", "finish_route", "arrive_point", "listen_guide",
    "ask_question", "view_parking", "adopt_parking", "book_guide", "feedback",
))


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
    Path(path).write_text(text + "\n", encoding="utf-8")


def require_id(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(rf"{prefix}[0-9]{{3,}}", value):
        raise ValueError(f"无效的 {prefix} ID：{value!r}")
    return value


def index_by_id(rows, field, prefix):
    index = {}
    for row in rows:
        key = require_id(row[field], prefix)
        if key in index:
            raise ValueError(f"重复的 {field}：{key}")
        index[key] = row
    return index


def timestamp(value):
    """Accept an ISO 8601 timestamp with the required explicit UTC+8 offset."""
    if not isinstance(value, str) or not value.endswith("+08:00") or "T" not in value:
        raise ValueError(f"时间必须为带 +08:00 的 ISO 8601 时间戳：{value!r}")
    return datetime.fromisoformat(value).astimezone(BEIJING)


def coordinates(row):
    if row.get("coord_system", "WGS84") != "WGS84":
        raise ValueError("坐标必须使用 WGS84")
    lon, lat = row["longitude"], row["latitude"]
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError(f"经纬度超出范围：{lon}, {lat}")
    return lon, lat


def nonnegative(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"应为非负数：{value!r}")
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"应为非负数：{value!r}")
    return value


def _clock(value):
    if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00", value):
        raise ValueError(f"无效时刻：{value!r}")
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def parse_hours(value):
    """Parse one or more half-open HH:MM ranges, including overnight ranges."""
    if value is None or value == "closed":
        return ()
    intervals = []
    for interval in [value] if isinstance(value, str) else value:
        begin, end = map(_clock, interval.split("-"))
        if begin == 1440 or begin == end:
            raise ValueError(f"无效开放时段：{interval!r}")
        intervals.append((begin, end if end > begin else end + 1440))
    return tuple(intervals)


def validate_points(rows):
    points = index_by_id(rows, "point_id", "LD")
    for point in points.values():
        if point["coord_system"] != "WGS84":
            raise ValueError("点位必须使用 WGS84")
        coordinates(point)
        if point["category"] not in CATEGORIES or not set(point["interest_tags"]) <= INTEREST_TAGS:
            raise ValueError(f"类别或兴趣标签不在契约范围内：{point['point_id']}")
        if nonnegative(point["visit_minutes"]) == 0:
            raise ValueError(f"停留时间必须大于零：{point['point_id']}")
        if point["crowd_level"] not in ("low", "medium", "high", "unknown"):
            raise ValueError(f"无效 crowd_level：{point['point_id']}")
        for field, prefix in (("history_id", "HIS"), ("kg_id", "KG"), ("guide_content_id", "GD")):
            if point[field] is not None:
                require_id(point[field], prefix)
        for day in point["opening_hours"]["closed_days"]:
            if day.lower() not in WEEKDAYS:
                datetime.strptime(day, "%Y-%m-%d")
        for day in ("mon_fri", "sat_sun"):
            parse_hours(point["opening_hours"][day])
    return points


def validate_parking(rows, points):
    lots = index_by_id(rows, "parking_id", "PK")
    for lot in lots.values():
        if lot["coord_system"] != "WGS84":
            raise ValueError("停车场必须使用 WGS84")
        coordinates(lot)
        spaces = nonnegative(lot["total_spaces"])
        if not isinstance(spaces, int) or spaces == 0:
            raise ValueError(f"停车容量必须为正整数：{lot['parking_id']}")
        for field in ("first_hour", "after_hour", "daily_cap"):
            nonnegative(lot["fee_rule"][field])
        parse_hours(lot["open_hours"])
        if lot["point_id"] is not None and lot["point_id"] not in points:
            raise ValueError(f"停车场关联了未知点位：{lot['parking_id']}")
    return lots


def read_visitor_events(path):
    """Read contract CSV. The interest_tags cell is a JSON array or blank."""
    with Path(path).open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if tuple(reader.fieldnames or ()) != EVENT_COLUMNS:
            raise ValueError("visitor_events.csv 列名或顺序不符合契约")
        rows = []
        for row in reader:
            if None in row or None in row.values():
                raise ValueError(f"visitor_events.csv 第 {reader.line_num} 行列数不一致")
            require_id(row["visitor_id"], "V")
            timestamp(row["ts"])
            if row["event_type"] not in EVENT_TYPES:
                raise ValueError(f"无效事件类型：{row['event_type']}")
            for field, prefix in (("point_id", "LD"), ("route_id", "R")):
                row[field] = require_id(row[field], prefix) if row[field] else None
            row["dwell_seconds"] = nonnegative(float(row["dwell_seconds"] or 0))
            row["interest_tags"] = json.loads(row["interest_tags"] or "[]")
            if not isinstance(row["interest_tags"], list):
                raise ValueError("interest_tags 必须为 JSON 数组")
            if not set(row["interest_tags"]) <= INTEREST_TAGS:
                raise ValueError("游客事件含未知兴趣标签")
            rows.append(row)
    return rows


def write_visitor_events(path, events):
    with Path(path).open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, EVENT_COLUMNS)
        writer.writeheader()
        for row in events:
            writer.writerow(row | {"interest_tags": json.dumps(row["interest_tags"], ensure_ascii=False)})
