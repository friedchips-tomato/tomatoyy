"""Interpret dated facts as intervals so uncertain dates remain uncertain."""

import re
from datetime import date, datetime, timedelta, timezone

BEIJING = timezone(timedelta(hours=8))
TIME_FIELDS = (
    "时间", "发生时间", "年代", "年份", "建成年代", "建成时间", "建造时间", "修复时间", "year",
    "date", "time", "event_date", "built_year",
)
SINGLE_DATE = re.compile(
    r"(\d{4})(?:-(\d{2})-(\d{2})|年(?:(\d{1,2})月(?:(\d{1,2})日)?)?)?"
)
YEAR_SPAN = re.compile(r"(\d{4})年?\s*[-–—~～至到]\s*(\d{4})年?")
DECADE = re.compile(r"(\d{3}0)年代")


def parse_period(value):
    if isinstance(value, dict) and "start" in value and "end" in value:
        start, end = parse_period(value["start"]), parse_period(value["end"])
        if start and end and start[0] <= end[1]:
            return start[0], end[1]
        return None
    if type(value) not in (str, int):
        return None
    text = str(value).strip()
    span, decade, single = YEAR_SPAN.fullmatch(text), DECADE.fullmatch(text), SINGLE_DATE.fullmatch(text)
    try:
        if span:
            start, end = map(int, span.groups())
            return (date(start, 1, 1), date(end, 12, 31)) if start <= end else None
        if decade:
            start = int(decade[1])
            return date(start, 1, 1), date(start + 9, 12, 31)
        if single:
            year = int(single[1])
            month, day = (single[2], single[3]) if single[2] else (single[4], single[5])
            if month:
                month = int(month)
                if day:
                    exact = date(year, month, int(day))
                    return exact, exact
                return date(year, month, 1), date(year, month, 28)
            return date(year, 1, 1), date(year, 12, 31)
        if "T" in text:
            stamp = datetime.fromisoformat(text)
            if stamp.tzinfo is not None:
                exact = stamp.astimezone(BEIJING).date()
                return exact, exact
    except (ValueError, OverflowError):
        pass
    return None


def entity_period(entity):
    for field in TIME_FIELDS:
        period = parse_period(entity["attributes"].get(field))
        if period:
            return period
    return None
