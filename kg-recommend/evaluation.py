"""Compare card-level click proxies using paired, synthetic browsing sessions."""

import csv
import random
from collections import Counter
from datetime import datetime, timedelta

from chronology import BEIJING
from graph import RECOMMENDATION_GROUPS, START_TYPES
from recommend import recommend

SEED = 20261122
VISITORS = 320
CARDS_PER_VISIT = 4
POSITION_FACTORS = (1.0, 0.8, 0.65, 0.5)
VIEW = "view_recommendation"
CLICK = "click_recommendation"
EVENT_FIELDS = (
    "visitor_id", "ts", "event_type", "point_id", "route_id", "dwell_seconds",
    "interest_tags", "device_lang", "data_source", "source_entity_id", "target_entity_id", "rank",
)


def _popularity_order(graph, source, tag_counts):
    candidates = [entity_id for entity_id in graph.short_paths(source)
                  if graph.entities[entity_id]["entity_type"] in RECOMMENDATION_GROUPS]
    return sorted(candidates, key=lambda node: (
        -sum(tag_counts[tag] for tag in set(graph.entities[node]["tags"])), node,
    ))


def _event_counts(rows):
    counts = Counter(row["event_type"] for row in rows)
    views = counts[VIEW]
    return {"clicks": counts[CLICK], "impressions": views,
            "ctr": round(counts[CLICK] / views, 6) if views else None}


def evaluate_ctr(graph, output_dir=None):
    rng = random.Random(SEED)
    origins = sorted(node for node, entity in graph.entities.items()
                     if entity["entity_type"] in START_TYPES)
    tags = Counter(tag for entity in graph.entities.values() for tag in set(entity["tags"]))
    origins_with_data = []
    for source in origins:
        cards = [item["entity_id"] for item in recommend(graph, source, limit=CARDS_PER_VISIT)["items"]]
        origins_with_data.append((source, cards, _popularity_order(graph, source, tags)[:len(cards)]))
    evaluated_arms = {"semantic": [], "tag_popularity": []}
    groups = tuple(dict.fromkeys(RECOMMENDATION_GROUPS.values()))
    start = datetime(2026, 11, 22, 9, tzinfo=BEIJING)
    for visitor in range(VISITORS if origins else 0):
        source, semantic, baseline = origins_with_data[visitor % len(origins)]
        source_tags = sorted(set(graph.entities[source]["tags"]))
        interests = {rng.choice(source_tags)} if source_tags else set()
        if other := sorted(tags.keys() - interests):
            interests.add(rng.choice(other))
        preferred = rng.choice(groups)
        # Draw once per position, before either ranking is evaluated.
        draws = [rng.random() for _ in POSITION_FACTORS]
        for arm, cards in (("semantic", semantic), ("tag_popularity", baseline)):
            for index, target in enumerate(cards):
                entity = graph.entities[target]
                overlap = len(interests.intersection(entity["tags"])) / max(1, len(interests))
                preference = RECOMMENDATION_GROUPS[entity["entity_type"]] == preferred
                probability = (0.04 + 0.32 * overlap + 0.12 * preference) * POSITION_FACTORS[index]
                ts = start + timedelta(minutes=visitor, seconds=3 * index)
                row = dict(
                    visitor_id=f"V{visitor + 1:04}", ts=ts.isoformat(),
                    event_type=VIEW, point_id=graph.entities[source].get("point_id") or "",
                    route_id="", dwell_seconds="", interest_tags="|".join(sorted(interests)),
                    device_lang="zh-CN", data_source="synthetic", source_entity_id=source,
                    target_entity_id=target, rank=index + 1,
                )
                evaluated_arms[arm].append(row)
                if draws[index] < probability:
                    evaluated_arms[arm].append({**row, "event_type": CLICK,
                                                "ts": (ts + timedelta(seconds=1)).isoformat()})
    results = {}
    for arm, rows in evaluated_arms.items():
        if output_dir is not None:
            path = output_dir / f"visitor_events_{arm}.csv"
            with path.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=EVENT_FIELDS)
                writer.writeheader()
                writer.writerows(rows)
        results[arm] = _event_counts(rows)
    semantic, baseline = results["semantic"]["ctr"], results["tag_popularity"]["ctr"]
    delta = round(semantic - baseline, 6) if semantic is not None and baseline is not None else None
    return {
        "data_source": "synthetic", "seed": SEED, "visitors_per_arm": VISITORS if origins else 0,
        "source_entities": len(origins), "cards_per_visit_max": CARDS_PER_VISIT,
        "position_factors": list(POSITION_FACTORS),
        "click_probability": "(0.04 + 0.32 * interest_overlap + 0.12 * preferred_group) * position",
        "formula": "click_recommendation count / view_recommendation count",
        "baseline": "eligible candidates sorted by sum of graph-wide tag document frequencies",
        "absolute_ctr_delta": delta, **results,
    }
