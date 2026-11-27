"""Time-window and geographic distance calculations."""

from datetime import timedelta
from math import asin, cos, radians, sin, sqrt

from io_utils import WEEKDAYS, parse_hours

EPSILON = 1e-8


def haversine(origin, destination):
    lon1, lat1 = map(radians, origin)
    lon2, lat2 = map(radians, destination)
    value = sin((lat2 - lat1) / 2) ** 2
    value += cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_008.8 * asin(sqrt(min(1.0, value)))


def opening_windows(hours, start, budget):
    """Return merged windows in minutes relative to start, including overnight carry-in."""
    if isinstance(hours, dict):
        weekdays = parse_hours(hours["mon_fri"])
        weekends = parse_hours(hours["sat_sun"])
        closed = {day.lower() for day in hours["closed_days"]}
    else:
        weekdays = weekends = parse_hours(hours)
        closed = set()
    midnight = start.replace(hour=0, minute=0, second=0, microsecond=0)
    start_minute = (start - midnight).total_seconds() / 60
    last_day = int((start_minute + budget) // 1440)

    def is_closed(day):
        return day.isoformat() in closed or WEEKDAYS[day.weekday()] in closed

    intervals = []
    for offset in range(-1, last_day + 1):
        day = midnight.date() + timedelta(days=offset)
        if is_closed(day):
            continue
        next_closed = is_closed(day + timedelta(days=1))
        for begin, end in weekdays if day.weekday() < 5 else weekends:
            if next_closed:
                end = min(1440, end)
            shift = 1440 * offset - start_minute
            begin, end = begin + shift, end + shift
            if end > 0 and begin <= budget:
                intervals.append((max(0.0, begin), end))
    merged = []
    for begin, end in sorted(intervals):
        if merged and begin <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((begin, end))
    return tuple(merged)


def fits(windows, begin, end):
    return any(opens <= begin + EPSILON and end <= closes + EPSILON for opens, closes in windows)


def within(value, limit):
    return value <= limit + EPSILON


def at(start, offset_minutes):
    return (start + timedelta(minutes=offset_minutes)).isoformat(timespec="milliseconds")


def distance_record(straight_m, detour, speed):
    walk_m = straight_m * detour
    return {
        "straight_distance_meters": round(straight_m, 3),
        "distance_meters": round(walk_m, 3),
        "walk_minutes": round(walk_m / speed, 6),
    }
