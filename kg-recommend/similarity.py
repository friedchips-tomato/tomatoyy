"""Features shared by graph ranking and storyline search."""

from math import prod

from graph import RELATION_TYPES


def shared_tags(left, right):
    return set(left["tags"]) & set(right["tags"])


def tag_similarity(left, right):
    union = set(left["tags"]) | set(right["tags"])
    return len(shared_tags(left, right)) / len(union) if union else 0.0


def edge_strength(graph, step):
    weight = graph.relations[step.relation_id]["weight"]
    return weight * RELATION_TYPES[step.relation_type].weight


def path_strength(graph, path):
    weights = [edge_strength(graph, step) for step in path]
    return 0.75 ** (len(weights) - 1) * prod(weights) ** (1 / len(weights))


def relatedness(graph, source, destination, paths):
    # Prefer fewer hops and stable edge IDs when strengths tie.
    best = min(paths, key=lambda path: (
        -path_strength(graph, path), len(path), tuple(step.relation_id for step in path),
    ))
    intermediates = {path[0].destination for path in paths if len(path) == 2}
    shared = len(intermediates)
    score = (
        0.35 * tag_similarity(graph.entities[source], graph.entities[destination])
        + 0.25 * shared / (1 + shared)
        + 0.40 * path_strength(graph, best)
    )
    return score, best, intermediates
