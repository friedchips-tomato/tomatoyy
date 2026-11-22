"""Parking ranking and advisory departure times using contract forecast records."""

from dataclasses import dataclass
from datetime import timedelta
from math import ceil, sqrt

from io_utils import coordinates, nonnegative, timestamp
from schedule import distance_record, fits, haversine, opening_windows


@dataclass(frozen=True)
class ParkingSettings:
    distance_scale_m: float = 400
    fee_scale_yuan: float = 10
    forecast_tolerance_minutes: float = 30
    forecast_gain_ratio: float = 0.15
    advice_horizon_minutes: int = 180


def fee_for(lot, duration):
    rule = lot["fee_rule"]
    hours = ceil(duration / 60)
    return min(rule["daily_cap"], rule["first_hour"] + max(0, hours - 1) * rule["after_hour"])


def is_peak(at_time):
    hour = at_time.hour
    peaks = ((10, 12), (14, 17)) if at_time.weekday() >= 5 else ((11, 13), (17, 19))
    return any(begin <= hour < end for begin, end in peaks)


class Parking:
    def __init__(self, lots, forecasts, settings):
        self.lots = lots
        self.settings = settings
        self.forecasts = {}
        for record in forecasts:
            key = record["parking_id"]
            if key not in lots:
                raise ValueError(f"预测使用了未知停车场 ID：{key}")
            slots = self.forecasts.setdefault(key, {})
            for row in record["forecast"]:
                at_time = timestamp(row["ts"])
                spaces = nonnegative(row["predicted_free_spaces"])
                if at_time in slots or spaces > lots[key]["total_spaces"]:
                    raise ValueError(f"预测时刻重复或预测余位超过容量：{key} {row['ts']}")
                slots[at_time] = spaces

    def availability(self, key, at_time):
        forecasts = self.forecasts.get(key, {})
        if forecasts:
            sample = min(forecasts, key=lambda ts: (abs(ts - at_time), ts))
            tolerance = timedelta(minutes=self.settings.forecast_tolerance_minutes)
            if abs(sample - at_time) <= tolerance:
                return forecasts[sample], "forecast", sample.isoformat()
        return self.lots[key]["total_spaces"], "static_capacity", None

    def rank(self, at_time, budget, destination, detour, speed):
        options = []
        for key, lot in self.lots.items():
            spaces, source, forecast_ts = self.availability(key, at_time)
            ratio = spaces / lot["total_spaces"]
            distance = distance_record(haversine(coordinates(lot), destination), detour, speed)
            fee = fee_for(lot, budget)
            score = sqrt(1 + spaces) * (0.25 + 0.75 * ratio)
            score /= 1 + distance["distance_meters"] / self.settings.distance_scale_m
            score /= 1 + fee / self.settings.fee_scale_yuan
            open_now = fits(opening_windows(lot["open_hours"], at_time, budget), 0, 0)
            options.append({
                "parking_id": key,
                "name": lot["name"],
                "predicted_free_spaces": spaces if source == "forecast" else None,
                "available_spaces_for_ranking": spaces,
                "availability_source": source,
                "availability_note": "使用预测余位" if source == "forecast" else "仅使用静态容量作排序",
                "forecast_ts": forecast_ts,
                "total_spaces": lot["total_spaces"],
                "estimated_fee_yuan": fee,
                "open_at_start": open_now,
                "selectable": open_now and spaces > 0,
                "score": round(score, 6),
                **distance,
            })
        return sorted(options, key=lambda row: (
            not row["selectable"], -row["score"], row["parking_id"],
        ))

    def advice(self, key, at_time, budget):
        if key is None:
            return None
        lot = self.lots[key]
        current_free, current_source, _ = self.availability(key, at_time)
        peak_now = is_peak(at_time)
        for delay in range(30, self.settings.advice_horizon_minutes + 1, 30):
            later = at_time + timedelta(minutes=delay)
            if not fits(opening_windows(lot["open_hours"], later, budget), 0, budget):
                continue
            future_free, source, _ = self.availability(key, later)
            gain = (future_free - current_free) / lot["total_spaces"]
            if current_source == source == "forecast" and gain >= self.settings.forecast_gain_ratio:
                basis = "forecast"
                reason = f"预测余位由 {current_free:g} 增至 {future_free:g}，可考虑稍晚到达。"
            elif peak_now and not is_peak(later) and source == "static_capacity":
                basis = "time_of_day"
                reason = "按示例高峰时段建议稍晚到达，实际余位以停车场信息为准。"
            else:
                continue
            return {
                "parking_id": key,
                "suggested_start_time": later.isoformat(),
                "delay_minutes": delay,
                "basis": basis,
                "reason": reason,
            }
        return None
