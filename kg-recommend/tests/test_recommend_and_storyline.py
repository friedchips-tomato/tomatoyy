"""Recommendation ranking, explanations, and storyline generation."""

import pytest

from conftest import storyline_dict
from graph import ENTITY_TYPES, RECOMMENDATION_GROUPS, START_TYPES
from recommend import recommend
from storyline import STORY_LENGTHS, generate_storyline


def test_recommendation_groups_and_limits(graph):
    result = recommend(graph, "KG001", per_type=2, limit=6)
    assert result["source_entity_id"] == "KG001"
    assert len(result["items"]) == 6
    seen = {}
    for item in result["items"]:
        seen[item["recommendation_group"]] = seen.get(item["recommendation_group"], 0) + 1
        assert item["entity_id"] != "KG001"
        assert item["entity_type"] in ENTITY_TYPES
        assert 0 < item["score"] <= 1
        assert item["path"], "每条推荐必须带关系路径"
        assert item["reasons"], "每条推荐必须带中文理由"
        assert all(isinstance(reason, str) and reason for reason in item["reasons"])
    assert all(count <= 2 for count in seen.values())


def test_recommendation_per_type_covers_all_groups(graph):
    for source in sorted(graph.entities):
        if graph.entities[source]["entity_type"] not in START_TYPES:
            continue
        result = recommend(graph, source, per_type=1)
        groups = {item["recommendation_group"] for item in result["items"]}
        assert groups <= set(RECOMMENDATION_GROUPS.values())


def test_recommendation_scores_are_ranked(graph):
    scores = [item["score"] for item in recommend(graph, "KG001")["items"]]
    assert scores == sorted(scores, reverse=True)


def test_recommendation_rejects_invalid_input(graph):
    with pytest.raises(ValueError, match="起点"):
        recommend(graph, "KG018")  # place entities are not valid anchors
    with pytest.raises(ValueError, match="起点"):
        recommend(graph, "KG999")
    with pytest.raises(ValueError):
        recommend(graph, "KG001", per_type=0)


def test_person_anchor_also_recommends(graph):
    result = recommend(graph, "KG006")
    assert result["items"]
    # A person's building shows up via built_by traversed in reverse.
    assert "KG001" in {item["entity_id"] for item in result["items"]}


@pytest.mark.parametrize("length", STORY_LENGTHS)
def test_storyline_lengths_and_traceability(graph, length):
    story = generate_storyline(graph, "KG002", length, "贸易")
    assert len(story["nodes"]) == length
    assert len(story["transitions"]) == length - 1
    assert story["nodes"][0]["entity_id"] == "KG002"
    assert story["nodes"][0]["role"] == "anchor"
    assert all(node["reason"] for node in story["nodes"])
    for transition in story["transitions"]:
        assert transition["connector_text"]
        assert transition["from"] != transition["to"]
    # The storyline must be a continuous chain over graph nodes.
    chain = [story["nodes"][0]["entity_id"]]
    for transition in story["transitions"]:
        assert chain[-1] == transition["from"]
        chain.append(transition["to"])
    assert len(set(chain)) == len(chain), "故事线节点不得重复"


def test_storyline_allows_theme_without_tag_match(graph):
    story = generate_storyline(graph, "KG003", 3, "不存在的主题")
    assert len(story["nodes"]) == 3
    assert not any("包含「不存在的主题」" in node["reason"] for node in story["nodes"])


def test_storyline_citations_are_traceable(graph):
    story = storyline_dict(graph)
    node_ids = {node["entity_id"] for node in story["nodes"]}
    assert node_ids <= set(story["source_citations"]), "节点本身必须在引用中"


def test_storyline_rejects_invalid_input(graph):
    with pytest.raises(ValueError, match="起点"):
        generate_storyline(graph, "KG006", 5, "侨乡")
    with pytest.raises(ValueError):
        generate_storyline(graph, "KG001", 4, "侨乡")
    with pytest.raises(ValueError):
        generate_storyline(graph, "KG001", 5, " ")


def test_storyline_respects_chronology(graph):
    # The beam search never walks to a node that ends before the chain starts.
    from chronology import entity_period

    for building in ("KG001", "KG002", "KG003", "KG004", "KG005"):
        start = entity_period(graph.entities[building])
        story = generate_storyline(graph, building, 8, "侨乡")
        for node in story["nodes"][1:]:
            period = entity_period(graph.entities[node["entity_id"]])
            if period and start:
                assert period[1] >= start[0], f"{building} 的故事线出现早于起点的节点"
