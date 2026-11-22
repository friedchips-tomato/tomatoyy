"""Interest, crowd, cultural links and diversity in route ranking."""

from collections import Counter
from dataclasses import dataclass
from math import log1p

from io_utils import INTEREST_TAGS

CULTURAL_CATEGORIES = frozenset(("历史建筑", "文化场馆", "非遗业态"))
CROWD_COST = {"low": 0.0, "medium": 0.20, "high": 0.75, "unknown": 0.20}
EVENT_WEIGHT = {"arrive_point": 1, "listen_guide": 2, "ask_question": 1, "finish_route": 1}


@dataclass(frozen=True)
class Weights:
    interest: float = 1.85
    popularity: float = 0.30
    crowd: float = 1.0
    category_bonus: float = 0.30
    repeated_category: float = 0.16
    route_overlap: float = 0.55
    category_overlap: float = 0.30
    culture_category: float = 1.25
    culture_link: float = 1.35


def tag_heat(events, points):
    """Aggregate weighted engagement and log-scale heat to [0, 1]."""
    heat = Counter()
    for event in events:
        weight = EVENT_WEIGHT.get(event["event_type"], 0)
        point = points.get(event.get("point_id"), {})
        tags = event.get("interest_tags") or point.get("interest_tags", ())
        heat.update({tag: weight for tag in set(tags) if tag in INTEREST_TAGS and weight})
    normalizer = log1p(max(heat.values(), default=0)) or 1
    return {tag: log1p(count) / normalizer for tag, count in heat.items()}


def interest_weights(tags, profile):
    declared = set(tags)
    learned = profile.get("interest_weights", {})
    return {
        tag: (1.0 if tag in declared else 0.0) + 0.4 * min(1.0, max(0.0, learned.get(tag, 0)))
        for tag in declared | (learned.keys() & INTEREST_TAGS)
    }


def _jaccard(a, b):
    return len(a & b) / len(a | b) if a or b else 0.0


class Scoring:
    def __init__(self, points, preference, heat, kg_relations, weights):
        self.points = points
        self.preference = preference
        self.weights = weights
        self.kg_relations = kg_relations
        denominator = sum(preference.values()) or 1.0
        self.base = {}
        for key, point in points.items():
            tags = point["interest_tags"]
            match = sum(preference.get(tag, 0) for tag in tags) / denominator
            popularity = sum(heat.get(tag, 0) for tag in tags) / max(1, len(tags))
            crowd = CROWD_COST[point["crowd_level"]]
            self.base[key] = weights.interest * match + weights.popularity * popularity
            self.base[key] -= weights.crowd * crowd

    def point_value(self, key, focus):
        cultural = self.points[key]["category"] in CULTURAL_CATEGORIES
        return self.base[key] + (self.weights.culture_category * cultural if focus == "culture" else 0)

    def cultural_link(self, left, right):
        a, b = self.points[left]["kg_id"], self.points[right]["kg_id"]
        return self.kg_relations.get((a, b), 0) if a and b else 0

    def culture_links(self, ids):
        return sum(self.cultural_link(a, b) for a, b in zip(ids, ids[1:]))

    def categories(self, ids):
        return {self.points[key]["category"] for key in ids}

    def value(self, ids, focus):
        kinds = len(self.categories(ids))
        value = sum(self.point_value(key, focus) for key in ids)
        value += self.weights.category_bonus * kinds
        value -= self.weights.repeated_category * (len(ids) - kinds)
        if focus == "culture":
            value += self.weights.culture_link * self.culture_links(ids)
        return value

    def overlap_cost(self, ids, displayed):
        kinds = self.categories(ids)
        return sum(
            self.weights.route_overlap * _jaccard(set(ids), set(other))
            + self.weights.category_overlap * _jaccard(kinds, self.categories(other))
            for other in displayed
        )

    def matched_tags(self, ids):
        tags = {tag for key in ids for tag in self.points[key]["interest_tags"]}
        return sorted(tag for tag in tags if self.preference.get(tag, 0) > 0)
