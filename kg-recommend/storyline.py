"""Build a dated, traceable path first and render its facts with Chinese templates."""

from dataclasses import dataclass
from datetime import date

from chronology import entity_period
from graph import ALGO_VERSION, ENTITY_LABELS, RELATION_TYPES, history_refs
from similarity import edge_strength

STORY_LENGTHS = (3, 5, 8)


@dataclass(frozen=True)
class Candidate:
    nodes: tuple
    steps: tuple
    score: float
    earliest: date


def _candidate_key(candidate):
    # Longer chains first: a complete storyline must never lose to a high-scoring
    # dead end that stopped one hop short of the requested length.
    return (-len(candidate.nodes), -candidate.score, candidate.nodes,
            tuple(step.relation_id for step in candidate.steps))


def _extend(graph, candidate, periods, theme):
    for step in graph.incident(candidate.nodes[-1]):
        destination = step.destination
        if destination in candidate.nodes:
            continue
        relation = graph.relations[step.relation_id]
        if graph.compatible(relation) is False:
            continue
        period = periods[destination]
        if period and period[1] < candidate.earliest:
            continue
        earliest = max(candidate.earliest, period[0]) if period else candidate.earliest
        node = graph.entities[destination]
        new_type = all(node["entity_type"] != graph.entities[old]["entity_type"]
                       for old in candidate.nodes)
        score = (0.55 * edge_strength(graph, step) + 0.30 * (theme in node["tags"])
                 + 0.15 * new_type)
        yield Candidate(candidate.nodes + (destination,), candidate.steps + (step,),
                        candidate.score + score, earliest)


def _render_transition(graph, step):
    relation = graph.relations[step.relation_id]
    src = graph.entities[relation["src_id"]]["name"]
    dst = graph.entities[relation["dst_id"]]["name"]
    spec = RELATION_TYPES[step.relation_type]
    fact = spec.phrase.format(src=f"「{src}」", dst=f"「{dst}」")
    connector = "沿着这条关系看过去，" if step.reversed else "接着可以看到，"
    return {**step.as_dict(), "connector_text": f"{connector}{fact}。"}


def _render_node(graph, entity_id, incoming, theme):
    entity = graph.entities[entity_id]
    name = entity["name"]
    kind = ENTITY_LABELS[entity["entity_type"]]
    if incoming is None:
        role = "anchor"
        reason = f"从指定的{kind}「{name}」开始探索。"
    else:
        role = "related"
        previous = graph.entities[incoming.origin]["name"]
        label = RELATION_TYPES[incoming.relation_type].label
        reason = f"由「{previous}」沿「{label}」关系可探索此{kind}。"
    if theme in entity["tags"]:
        reason += f"条目包含「{theme}」主题。"
    one_line = f"{name}（{kind}）。"
    if entity["summary"]:
        one_line += entity["summary"]
    return {
        "entity_id": entity_id, "entity_type": entity["entity_type"], "role": role,
        "display_name": name, "one_line": one_line, "reason": reason,
    }


def generate_storyline(graph, building_id, length=5, theme="侨乡", *, beam_width=64):
    source = graph.entities[building_id]
    if source["entity_type"] != "building":
        raise ValueError("故事线起点必须是建筑")
    if length not in STORY_LENGTHS or beam_width < 1 or not theme.strip():
        raise ValueError("故事线需指定 3、5 或 8 点，且主题与搜索宽度不能为空")
    theme = theme.strip()
    periods = {entity_id: entity_period(entity) for entity_id, entity in graph.entities.items()}
    earliest = periods[building_id][0] if periods[building_id] else date.min
    frontier = [Candidate((building_id,), (), 0.0, earliest)]
    for _ in range(length - 1):
        following = sorted(
            (extension for path in frontier for extension in _extend(graph, path, periods, theme)),
            key=_candidate_key,
        )[:beam_width]
        if not following:
            break
        frontier = following

    best = frontier[0]
    records = [graph.entities[node] for node in best.nodes]
    records.extend(graph.relations[step.relation_id] for step in best.steps)
    citations = set().union(*(history_refs(record) for record in records)) & graph.history_ids
    prefix = "【示例】" if graph.source == "sample" else ""
    return {
        "title": f"{prefix}从{source['name']}探索{theme}",
        "theme": theme,
        "nodes": [_render_node(graph, node, incoming, theme)
                  for node, incoming in zip(best.nodes, (None, *best.steps))],
        "transitions": [_render_transition(graph, step) for step in best.steps],
        "source_citations": [*best.nodes, *sorted(citations)],
        "algo_version": ALGO_VERSION,
    }
