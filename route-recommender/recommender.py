"""Bounded time-window orienteering and route progress for Changdi."""

from copy import deepcopy
from dataclasses import dataclass
from functools import lru_cache
from itertools import count
from time import perf_counter

from io_utils import (
    INTEREST_TAGS, coordinates, nonnegative, require_id, timestamp, validate_parking, validate_points,
)
from parking import Parking, ParkingSettings, fee_for
from schedule import at, distance_record, fits, haversine, opening_windows, within
from scoring import Scoring, Weights, interest_weights, tag_heat

VERSION = "route-recommender-0.1.0"
PACE_FACTOR = {"relaxed": 1.15, "normal": 1.0, "deep": 1.45}
FOCUSES = ("culture", "distance", "depth")
TRANSIT_TAG = "公交接驳"


@dataclass(frozen=True)
class RouteSettings:
    detour_factor: float = 1.3
    walking_m_per_min: float = 75
    candidate_limit: int = 24
    starts_per_focus: int = 3
    local_passes: int = 2
    required_beam_width: int = 16
    transit_max_walk_m: float = 350
    weights: Weights = Weights()
    parking: ParkingSettings = ParkingSettings()

    def __post_init__(self):
        if nonnegative(self.detour_factor) < 1 or nonnegative(self.walking_m_per_min) == 0:
            raise ValueError("绕行系数至少为 1，步行速度必须大于零")
        if min(self.candidate_limit, self.starts_per_focus, self.required_beam_width) < 1:
            raise ValueError("候选池、起始方案和必去点束宽必须至少为 1")
        nonnegative(self.transit_max_walk_m)


@dataclass(frozen=True, slots=True)
class Tour:
    ids: tuple
    straight_m: float
    walk: float
    visit: float
    endpoint: str | None = None
    endpoint_straight_m: float = 0

    @property
    def total(self):
        return self.walk + self.visit


class RouteSearch:
    def __init__(self, plan, request, start, origin, budget, max_walk, parking_id, preferred):
        self.plan = plan
        self.settings = plan.settings
        self.origin = origin
        self.start = start
        self.budget = budget
        self.max_walk = max_walk
        self.parking_id = parking_id
        self.preferred = preferred
        self.excluded = set(request["excluded_point_ids"])
        self.factor = self.settings.detour_factor / self.settings.walking_m_per_min
        self.origin_dist = {key: haversine(origin, loc) for key, loc in plan.locations.items()}
        self.windows = {}
        self.dwell = {}
        self.transit_windows = {}
        for key, point in plan.points.items():
            if key in self.excluded or point["category"] == "停车场":
                continue
            windows = opening_windows(point["opening_hours"], start, budget)
            if TRANSIT_TAG in point["style_tags"] and point["category"] == "公共服务":
                if parking_id is None and windows:
                    self.transit_windows[key] = windows
                continue
            dwell = point["visit_minutes"] * PACE_FACTOR[request["pace"]]
            if any(within(begin + dwell, min(end, budget)) for begin, end in windows):
                self.windows[key] = windows
                self.dwell[key] = dwell
        self.parking_windows = (
            opening_windows(plan.lots[parking_id]["open_hours"], start, budget) if parking_id else ()
        )
        tags = interest_weights(request["interest_tags"], plan.profiles.get(request["visitor_id"], {}))
        self.scoring = Scoring(plan.points, tags, plan.heat, plan.kg_relations, self.settings.weights)
        self.cached_evaluate = lru_cache(maxsize=8192)(self.evaluate)

    def edge(self, previous, following):
        return self.origin_dist[following] if previous is None else self.plan.distance[previous][following]

    def evaluate(self, ids, finish=True):
        straight = visit = 0.0
        previous = None
        for key in ids:
            straight += self.edge(previous, key)
            arrival = straight * self.factor + visit
            dwell = self.dwell[key]
            if not within(arrival + dwell, self.budget):
                return None
            if not within(straight * self.factor, self.max_walk):
                return None
            if not fits(self.windows[key], arrival, arrival + dwell):
                return None
            visit += dwell
            previous = key
        end = self.parking_id if finish else None
        last_leg = 0.0
        if end:
            last_leg = self.edge(previous, end)
            if not fits(self.parking_windows, 0, (straight + last_leg) * self.factor + visit):
                return None
        elif finish and ids:
            end, last_leg = self.find_transit(previous, straight, visit)
        walk = (straight + last_leg) * self.factor
        if not within(walk + visit, self.budget) or not within(walk, self.max_walk):
            return None
        return Tour(ids, straight + last_leg, walk, visit, end, last_leg)

    def find_transit(self, previous, straight, visit):
        options = sorted((self.edge(previous, key), key) for key in self.transit_windows)
        for leg, key in options:
            if leg * self.settings.detour_factor > self.settings.transit_max_walk_m:
                break
            walk = (straight + leg) * self.factor
            arrival = walk + visit
            if within(arrival, self.budget) and within(walk, self.max_walk):
                if fits(self.transit_windows[key], arrival, arrival):
                    return key, leg
        return None, 0.0

    def required_seeds(self, required, prefix):
        if not required:
            seed = self.evaluate(())
            return [seed] if seed else []
        key_order = sorted(required)
        others = sorted(self.windows.keys() - required)
        seeds = self._beam(key_order, (), prefix)
        if not seeds:
            seeds = self._beam(key_order, others, prefix)
        return seeds[:self.settings.starts_per_focus]

    def _beam(self, required, bridges, prefix):
        initial = self.cached_evaluate(prefix, False)
        if initial is None:
            return []
        frontier, completed = [initial], []
        bridge_limit = 2 if bridges else 0
        for _ in range(len(required) - len(prefix) + bridge_limit + 1):
            following = []
            for tour in frontier:
                missing = [key for key in required if key not in tour.ids]
                if not missing:
                    final = self.cached_evaluate(tour.ids)
                    if final:
                        completed.append(final)
                    # A final bridge can reach a different transit endpoint, but cannot shorten a
                    # parking return or add time before a mandatory stop that was already visited.
                    continue
                used_bridges = len(tour.ids) - len(required) + len(missing)
                choices = missing + (bridges if used_bridges < bridge_limit else [])
                for key in choices:
                    if key not in tour.ids:
                        expanded = self.cached_evaluate(tour.ids + (key,), False)
                        if expanded:
                            following.append(expanded)
            # Retain some diversity in the latest stop and the set of pending required stops.
            following.sort(key=lambda tour: (
                -sum(key in tour.ids for key in required), tour.total, tour.walk, tour.ids,
            ))
            frontier = following[:self.settings.required_beam_width]
            if not frontier:
                break
        return sorted(completed, key=lambda tour: (tour.walk, tour.total, tour.ids))

    def route_value(self, tour, focus):
        value = self.scoring.value(tour.ids, focus) + 0.50 * len(self.preferred.intersection(tour.ids))
        walk_cost = 0.055 if focus == "culture" else 0.035
        return value - walk_cost * tour.walk

    def shortlist(self, focus, seed):
        def rank(key):
            leg = min(self.edge(anchor, key) for anchor in (None, *seed.ids)) * self.factor
            value = self.scoring.point_value(key, focus)
            if focus == "culture":
                value += max((self.scoring.cultural_link(anchor, key) for anchor in seed.ids), default=0)
                priority = (value + 0.5) / (4 + self.dwell[key] + leg)
            else:
                priority = (1 + 0.25 * value) / (self.dwell[key] + leg)
            return (-priority, key)

        keys = sorted(self.windows.keys() - set(seed.ids), key=rank)
        shortlist = set(keys[:self.settings.candidate_limit]) | (self.preferred & set(keys))
        return [key for key in keys if key in shortlist]

    def insert(self, seed, shortlist, focus, fixed, pool):
        tour = seed
        while True:
            previous_value = self.route_value(tour, focus)
            best = None
            for key in shortlist:
                if key in tour.ids:
                    continue
                for position in range(fixed, len(tour.ids) + 1):
                    ids = tour.ids[:position] + (key,) + tour.ids[position:]
                    candidate = self.cached_evaluate(ids)
                    if candidate is None:
                        continue
                    gain = self.route_value(candidate, focus) - previous_value
                    if focus == "culture" and gain <= 0 and tour.ids:
                        continue
                    added = max(1.0, candidate.total - tour.total)
                    priority = ((gain + (3 if focus == "depth" else 0)) / added, -candidate.walk)
                    if best is None or priority > best[0]:
                        best = (priority, candidate)
            if best is None:
                return tour
            tour = best[1]
            pool[tour.ids] = tour

    def improve_order(self, tour, focus, fixed):
        """Directed one-stop Or-opt, with a full time-window check in each new order."""
        for _ in range(self.settings.local_passes):
            best = tour
            for source in range(fixed, len(tour.ids)):
                remainder = tour.ids[:source] + tour.ids[source + 1:]
                for target in range(fixed, len(tour.ids)):
                    if source == target:
                        continue
                    ids = remainder[:target] + tour.ids[source:source + 1] + remainder[target:]
                    option = self.cached_evaluate(ids)
                    if option and self.route_value(option, focus) > self.route_value(best, focus):
                        best = option
            if best == tour:
                break
            tour = best
        return tour

    def candidates(self, seeds, fixed, baseline):
        pool = {tour.ids: tour for tour in seeds if tour.ids}
        all_single = [tour for key in sorted(self.windows) if (tour := self.cached_evaluate((key,)))]
        if not seeds[0].ids:
            pool.update({tour.ids: tour for tour in all_single})
        if baseline:
            starts = seeds if seeds[0].ids else sorted(all_single, key=lambda tour: (
                self.origin_dist[tour.ids[0]], tour.ids,
            ))[:self.settings.starts_per_focus]
            return self.nearest_neighbor(starts)
        for seed in seeds:
            for focus in ("culture", "depth"):
                shortlist = self.shortlist(focus, seed)
                # Keep feasible one-stop extensions of each seed for sparse candidate sets.
                alternatives = []
                for key in shortlist:
                    for position in range(fixed, len(seed.ids) + 1):
                        ids = seed.ids[:position] + (key,) + seed.ids[position:]
                        tour = self.cached_evaluate(ids)
                        if tour:
                            pool[tour.ids] = tour
                            alternatives.append(tour)
                alternatives.sort(key=lambda tour: (
                    -self.route_value(tour, focus) / max(tour.total, 1), tour.ids,
                ))
                # Explore different first additions, not different insertion positions of one point.
                starts = [seed]
                seen = set()
                for tour in alternatives:
                    added = (set(tour.ids) - set(seed.ids)).pop()
                    if added not in seen:
                        starts.append(tour)
                        seen.add(added)
                    if len(starts) == self.settings.starts_per_focus:
                        break
                for start in starts[:self.settings.starts_per_focus]:
                    final = self.insert(start, shortlist, focus, fixed, pool)
                    improved = self.improve_order(final, focus, fixed)
                    if improved.ids:
                        pool[improved.ids] = improved
        return list(pool.values())

    def nearest_neighbor(self, seeds):
        """Distance-only comparison policy with the same feasibility checks."""
        pool = {}
        fallbacks = {}
        for tour in seeds:
            while tour:
                fallbacks[tour.ids] = tour
                last = tour.ids[-1]
                remaining = self.windows.keys() - set(tour.ids)
                choices = sorted(remaining, key=lambda key: (self.edge(last, key), key))
                following = next((option for key in choices
                                  if (option := self.cached_evaluate(tour.ids + (key,)))), None)
                if following is None:
                    pool[tour.ids] = tour
                tour = following
        for tour in sorted(fallbacks.values(), key=lambda tour: (-len(tour.ids), tour.walk, tour.ids)):
            if len(pool) >= 3:
                break
            pool[tour.ids] = tour
        return list(pool.values())

    def select(self, candidates, baseline):
        if baseline:
            return list(zip(FOCUSES, candidates[:3]))
        # A candidate "route" must hold at least two stops to be meaningful; among those,
        # the shortest walk wins. Fall back to single stops only when nothing larger fits.
        distance = min(candidates, key=lambda tour: (
            len(tour.ids) < 2, tour.walk, -len(tour.ids), tour.ids,
        ))
        remaining = [tour for tour in candidates if tour != distance]
        if not remaining:
            return [("distance", distance)]
        depth = max(remaining, key=lambda tour: (
            len(tour.ids), set(tour.ids) != set(distance.ids),
            self.route_value(tour, "depth") - self.scoring.overlap_cost(tour.ids, [distance.ids]),
            -tour.walk,
        ))
        remaining.remove(depth)
        routes = [("distance", distance), ("depth", depth)]
        if remaining:
            displayed = [distance.ids, depth.ids]
            culture = max(remaining, key=lambda tour: (
                all(set(tour.ids) != set(other) for other in displayed),
                self.route_value(tour, "culture") - self.scoring.overlap_cost(tour.ids, displayed),
                -tour.walk,
            ))
            routes.insert(0, ("culture", culture))
        return routes

    def describe(self, tour, focus, baseline):
        settings = self.settings
        distance = distance_record(tour.straight_m, settings.detour_factor, settings.walking_m_per_min)
        links = self.scoring.culture_links(tour.ids)
        kinds = len(self.scoring.categories(tour.ids))
        lead = {
            "culture": "优先串联文化点位和主题" + ("，含相邻的故事线关联" if links else ""),
            "distance": f"步行较少，估算约 {distance['distance_meters']:.0f} 米",
            "depth": f"安排 {len(tour.ids)} 个打卡点，覆盖 {kinds} 类内容",
        }
        reasons = ["按与上一站的距离依次选择可游览点位" if baseline else lead[focus]]
        if tags := self.scoring.matched_tags(tour.ids):
            reasons.append("匹配兴趣：" + "、".join(tags))
        reasons.append(f"预计 {tour.total:.2f} 分钟，游览预算 {self.budget:g} 分钟")
        endpoint = self.describe_endpoint(tour)
        if self.parking_id:
            reasons.append("已预留步行返回停车场取车的时间")
        elif endpoint:
            reasons.append("末站接驳公交点，接驳步行已计入预算")
        score = (1 / (1 + tour.walk / 10) if focus == "distance"
                 else 1 / (1 + 1 / max(0.01, 1 + self.route_value(tour, focus))))
        return {
            "route_id": f"R{next(self.plan._route_ids):04d}",
            "side_focus": focus,
            "point_ids": list(tour.ids),
            "order": list(range(len(tour.ids))),
            **distance,
            "origin": {"longitude": self.origin[0], "latitude": self.origin[1], "coord_system": "WGS84"},
            "visit_minutes": round(tour.visit, 6),
            "total_minutes": round(tour.total, 6),
            "parking_id": self.parking_id,
            "reasons": reasons,
            "score": round(score, 6),
            "stops": self.describe_stops(tour),
            "endpoint": endpoint,
        }

    def describe_stops(self, tour):
        elapsed = 0.0
        previous = None
        stops = []
        for key in tour.ids:
            leg = self.edge(previous, key)
            arrival = elapsed + leg * self.factor
            elapsed = arrival + self.dwell[key]
            stops.append({
                "point_id": key,
                "name": self.plan.points[key]["name"],
                "arrival_time": at(self.start, arrival),
                "departure_time": at(self.start, elapsed),
                **distance_record(leg, self.settings.detour_factor, self.settings.walking_m_per_min),
            })
            previous = key
        return stops

    def describe_endpoint(self, tour):
        if not tour.endpoint:
            return None
        key = tour.endpoint
        destination = self.plan.lots[key] if self.parking_id else self.plan.points[key]
        details = {"parking_id": key, "estimated_fee_yuan": fee_for(destination, tour.total)
                   } if self.parking_id else {"point_id": key}
        return {
            "type": "return_to_parking" if self.parking_id else "public_transport_connection",
            "name": destination["name"],
            **details,
            "arrival_time": at(self.start, tour.total),
            **distance_record(tour.endpoint_straight_m, self.settings.detour_factor,
                              self.settings.walking_m_per_min),
        }


class RouteRecommender:
    def __init__(self, points, parking_lots=(), visitor_profiles=(), visitor_events=(),
                 kg_relations=(), parking_forecasts=(), settings=None):
        self.settings = settings or RouteSettings()
        self.points = validate_points(deepcopy(list(points)))
        self.lots = validate_parking(deepcopy(list(parking_lots)), self.points)
        self.profiles = {}
        for profile in visitor_profiles:
            key = require_id(profile["visitor_id"], "V")
            if key in self.profiles:
                raise ValueError(f"重复游客画像：{key}")
            self.profiles[key] = deepcopy(profile)
        self.heat = tag_heat(visitor_events, self.points)
        self.kg_relations = {}
        kg_ids = {point["kg_id"] for point in self.points.values()}
        for edge in kg_relations:
            a, b = edge["source_kg_id"], edge["target_kg_id"]
            if a not in kg_ids or b not in kg_ids or a is None or b is None:
                raise ValueError(f"关联引用了未知 kg_id：{a}, {b}")
            strength = nonnegative(edge["weight"])
            if strength > 1 or a == b or (a, b) in self.kg_relations:
                raise ValueError(f"无效或重复的有向关系：{a}, {b}")
            self.kg_relations[a, b] = strength
        self.parking = Parking(self.lots, parking_forecasts, self.settings.parking)
        self._route_ids = count(1)
        self.locations = {key: coordinates(row) for key, row in (self.points | self.lots).items()}
        self.distance = {key: {key: 0.0} for key in self.locations}
        seen = []
        for key, location in self.locations.items():
            for other, other_location in seen:
                self.distance[key][other] = self.distance[other][key] = haversine(location, other_location)
            seen.append((key, location))

    def _validate_request(self, request):
        require_id(request["visitor_id"], "V")
        origin = coordinates(request["origin"])
        start = timestamp(request["start_time"])
        if request["duration_minutes"] not in (30, 60, 120):
            raise ValueError("duration_minutes 必须为 30、60 或 120")
        if request["pace"] not in PACE_FACTOR or request["transport"] not in ("car", "walk"):
            raise ValueError("无效的 pace 或 transport")
        if not set(request["interest_tags"]) <= INTEREST_TAGS:
            raise ValueError("请求包含未知兴趣标签")
        if request["max_walk_minutes"] is not None:
            nonnegative(request["max_walk_minutes"])
        key = request["parking_id"]
        if key is not None and (key not in self.lots or request["transport"] != "car"):
            raise ValueError(f"请求包含未登记的停车场，或出行方式与停车场不符：{key}")
        for field in ("must_include_point_ids", "excluded_point_ids"):
            ids = request[field]
            if len(ids) != len(set(ids)) or not set(ids) <= self.points.keys():
                raise ValueError(f"{field} 包含未知或重复的点位 ID")
        return origin, start

    def generate(self, request, *, baseline=False):
        start_timer = perf_counter()
        origin, start = self._validate_request(request)
        budget = request["duration_minutes"]
        max_walk = request["max_walk_minutes"]
        max_walk = budget if max_walk is None else min(budget, max_walk)
        if request["transport"] == "walk":
            result = self._plan(request, origin, start, budget, max_walk, baseline=baseline)
        else:
            result = self._car_plan(request, origin, start, budget, max_walk, baseline)
        result["generated_ms"] = round((perf_counter() - start_timer) * 1000, 3)
        return result

    def _car_plan(self, request, origin, start, budget, max_walk, baseline):
        must = request["must_include_point_ids"]
        excluded = set(request["excluded_point_ids"])
        anchors = [key for key, row in self.points.items() if key not in excluded
                   and row["category"] != "停车场" and TRANSIT_TAG not in row["style_tags"]]
        anchor = must[0] if must else min(anchors, key=lambda key: (
            haversine(origin, self.locations[key]), key,
        ), default=None)
        destination = self.locations[anchor] if anchor else origin
        choices = self.parking.rank(start, budget, destination, self.settings.detour_factor,
                                    self.settings.walking_m_per_min)
        explicit = request["parking_id"]
        viable = [row["parking_id"] for row in choices if row["selectable"]
                  and (explicit is None or explicit == row["parking_id"])]
        best = self._result([], "parking_unavailable", "所选时段没有可用停车场")
        if viable:
            best = self._result([], "no_feasible_route", "停车往返及点位游览无法同时满足约束")
            for key in viable:
                candidate = self._plan(request, self.locations[key], start, budget, max_walk,
                                       parking_id=key, baseline=baseline)
                if best.get("parking_id") is None or len(candidate["routes"]) > len(best["routes"]):
                    best = candidate
                if best["status"] == "ok" or best["status"] == "conflicting_points":
                    break
        best["parking_options"] = choices
        advice_key = best.get("parking_id") if best["routes"] else explicit
        if advice_key is None:
            advice_key = choices[0]["parking_id"] if choices else None
        best["off_peak_advice"] = self.parking.advice(advice_key, start, budget)
        return best

    @staticmethod
    def _result(routes, status, message=None, parking_id=None):
        return {"algo_version": VERSION, "routes": routes, "status": status,
                "message": message, "parking_id": parking_id}

    def _plan(self, request, origin, start, budget, max_walk, *, parking_id=None, next_point=None,
              preferred=frozenset(), baseline=False):
        search = RouteSearch(self, request, start, origin, budget, max_walk, parking_id, preferred)
        required = set(request["must_include_point_ids"]) | ({next_point} if next_point else set())
        prefix = (next_point,) if next_point else ()
        if required & search.excluded:
            return self._result([], "conflicting_points", "同一点位同时要求访问和排除", parking_id)
        unavailable = sorted(required - search.windows.keys())
        if unavailable:
            message = "以下必去点无可用游览时段：" + "、".join(unavailable)
            return self._result([], "required_points_unavailable", message, parking_id)
        seeds = search.required_seeds(required, prefix)
        if not seeds or not (candidates := search.candidates(seeds, len(prefix), baseline)):
            return self._result([], "no_feasible_route", "在约束内未找到可行游览路线", parking_id)
        routes = [search.describe(tour, focus, baseline)
                  for focus, tour in search.select(candidates, baseline)]
        if len(routes) == 3:
            return self._result(routes, "ok", parking_id=parking_id)
        return self._result(routes, "limited_alternatives", "当前约束下可行候选不足三条", parking_id)

    def save_progress(self, request, route, *, completed_point_ids, elapsed_minutes,
                      walk_minutes_used, saved_at):
        """Build a portable snapshot. Elapsed and walking time are active trip measurements."""
        _, started = self._validate_request(request)
        if timestamp(saved_at) < started:
            raise ValueError("保存时间早于路线开始时间")
        require_id(route["route_id"], "R")
        completed = list(completed_point_ids)
        route_ids = route["point_ids"]
        if len(completed) != len(set(completed)) or not set(completed + route_ids) <= self.points.keys():
            raise ValueError("游览进度含未知点位或重复的已完成点位")
        key = route["parking_id"]
        if request["transport"] == "car" and (key not in self.lots or
                                               request["parking_id"] not in (key, None)):
            raise ValueError("保存的自驾路线必须使用请求指定或算法选定的停车场")
        if request["transport"] == "walk" and key is not None:
            raise ValueError("步行路线不能关联停车场")
        if nonnegative(walk_minutes_used) > nonnegative(elapsed_minutes):
            raise ValueError("累计步行时长不能超过累计游览时长")
        return {
            "progress_version": 1,
            "request": deepcopy(request),
            "route_id": route["route_id"],
            "remaining_point_ids": [key for key in route_ids if key not in completed],
            "completed_point_ids": completed,
            "parking_id": key,
            "elapsed_minutes": elapsed_minutes,
            "walk_minutes_used": walk_minutes_used,
            "saved_at": saved_at,
        }

    def replan(self, current_point_id, current_location, *, progress, now, next_point_id=None):
        """Replan from GPS or a known point, with remaining budgets and the same parked car."""
        timer = perf_counter()
        if progress["progress_version"] != 1 or timestamp(now) < timestamp(progress["saved_at"]):
            raise ValueError("未知进度版本或恢复时间早于保存时间")
        request = deepcopy(progress["request"])
        self._validate_request(request)
        for key in (current_point_id, next_point_id):
            if key is not None and key not in self.points:
                raise ValueError(f"未知点位：{key}")
        if current_location is None and current_point_id is None:
            raise ValueError("恢复路线需要当前位置或当前点位")
        origin = coordinates(current_location) if current_location else self.locations[current_point_id]
        start = timestamp(now)
        budget = max(0, request["duration_minutes"] - nonnegative(progress["elapsed_minutes"]))
        max_walk = request["max_walk_minutes"]
        if max_walk is not None:
            max_walk = max(0, max_walk - nonnegative(progress["walk_minutes_used"]))
        max_walk = budget if max_walk is None else min(budget, max_walk)
        visited = set(progress["completed_point_ids"])
        request["must_include_point_ids"] = sorted(set(request["must_include_point_ids"]) - visited)
        request["excluded_point_ids"] = sorted(set(request["excluded_point_ids"]) | visited)
        preferred = set(progress["remaining_point_ids"]) - visited
        parking_id = progress["parking_id"]
        if not preferred and not next_point_id and not request["must_include_point_ids"]:
            result = self._result([], "completed", "点位游览已完成", parking_id)
        else:
            result = self._plan(request, origin, start, budget, max_walk, parking_id=parking_id,
                                next_point=next_point_id, preferred=preferred)
        if parking_id and not result["routes"]:
            search = RouteSearch(self, request, start, origin, budget, max_walk, parking_id, preferred)
            if back := search.evaluate(()):
                result["return_to_parking"] = search.describe_endpoint(back)
            else:
                result["return_to_parking"] = None
                result["message"] += "；余下预算或开放时段不足以安排返回取车"
                if result["status"] == "completed":
                    result["status"] = "return_unavailable"
        result["generated_ms"] = round((perf_counter() - timer) * 1000, 3)
        return result
