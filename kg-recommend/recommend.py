"""Rank traceable neighbors and explain the evidence used for each result."""

from graph import ALGO_VERSION, ENTITY_LABELS, RECOMMENDATION_GROUPS, RELATION_TYPES, START_TYPES
from similarity import relatedness, shared_tags

DIVERSITY_PENALTY = 0.35


def recommend(graph, source_entity_id, *, per_type=3, limit=None):
    if source_entity_id not in graph.entities:
        raise ValueError("推荐起点必须是图谱中存在的建筑或人物")
    source = graph.entities[source_entity_id]
    if source["entity_type"] not in START_TYPES:
        raise ValueError("推荐起点必须是建筑或人物")
    if per_type < 1 or (limit is not None and limit < 0):
        raise ValueError("per_type 须为正数，limit 须为非负数")

    groups = {group: [] for group in RECOMMENDATION_GROUPS.values()}
    for entity_id, paths in graph.short_paths(source_entity_id).items():
        kind = graph.entities[entity_id]["entity_type"]
        if kind not in RECOMMENDATION_GROUPS:
            continue
        score, path, intermediates = relatedness(graph, source_entity_id, entity_id, paths)
        groups[RECOMMENDATION_GROUPS[kind]].append((score, entity_id, path, intermediates))

    ranked = []
    for group, candidates in groups.items():
        candidates.sort(key=lambda item: (-item[0], item[1]))
        for already_selected, (base, entity_id, path, intermediates) in enumerate(
            candidates[:per_type]
        ):
            score = base / (1 + DIVERSITY_PENALTY * already_selected)
            ranked.append((score, entity_id, group, path, intermediates))
    ranked.sort(key=lambda item: (-item[0], item[1]))

    items = []
    for score, entity_id, group, path, shared in ranked[:limit]:
        target = graph.entities[entity_id]
        tags = sorted(shared_tags(source, target))
        reasons = []
        if tags:
            reasons.append(f"与{source['name']}共享主题：{'、'.join(tags)}。")
        if shared:
            labels = [
                f"{ENTITY_LABELS[graph.entities[node]['entity_type']]}「{graph.entities[node]['name']}」"
                for node in sorted(shared)[:3]
            ]
            remaining = f"等{len(shared)}项" if len(shared) > len(labels) else ""
            reasons.append(f"两个条目均与{'、'.join(labels)}{remaining}相连。")
        route = []
        for step in path:
            label = RELATION_TYPES[step.relation_type].label
            arrow = f"←{label}—" if step.reversed else f"—{label}→"
            route.append(f"{arrow}「{graph.entities[step.destination]['name']}」")
        reasons.append(f"可循图谱关系探索：「{source['name']}」{''.join(route)}。")
        items.append({
            "entity_id": entity_id,
            "entity_type": target["entity_type"],
            "recommendation_group": group,
            "display_name": target["name"],
            "score": round(score, 6),
            "reasons": reasons,
            "path": [step.relation_type for step in path],
            "path_edges": [step.as_dict() for step in path],
        })
    return {"source_entity_id": source_entity_id, "items": items, "algo_version": ALGO_VERSION}
