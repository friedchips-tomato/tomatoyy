"""Graph loading validation, contract checks, and chronology parsing."""

from datetime import date

import pytest

from chronology import entity_period, parse_period
from conftest import PACKAGE, load_raw_sample, storyline_dict
from graph import KnowledgeGraph

SAMPLE = PACKAGE / "data" / "kg_sample.json"


def test_sample_graph_meets_minimum_size(graph):
    assert len(graph.entities) >= 20
    assert len(graph.relations) >= 40
    assert graph.source == "sample"
    assert all(entity["verified"] == 0 for entity in graph.entities.values())
    assert all(relation["verified"] == 0 for relation in graph.relations.values())


def test_sample_graph_has_history_ids(graph):
    # Entity sources are registered so citations can be validated.
    for entity in graph.entities.values():
        assert set(entity["sources"]) <= graph.history_ids


@pytest.mark.parametrize("mutation, message", [
    ({"entity_id": "KG002"}, "无效或重复"),
    ({"entity_id": "XX001"}, "无效或重复"),
    ({"point_id": "P1"}, "point_id 无效"),
    ({"entity_type": "寺庙"}, "entity_type 无效"),
    ({"tags": "侨乡"}, "tags 必须是字符串数组"),
    ({"verified": 1}, "verified=0"),
    ({"sources": ["SAMPLE"]}, "HIS 编号"),
])
def test_bad_entity_is_rejected(graph, mutation, message):
    data = load_raw_sample()
    data["entities"][0] = {**data["entities"][0], **mutation}
    with pytest.raises(ValueError, match=message):
        KnowledgeGraph(data)


@pytest.mark.parametrize("mutation, message", [
    ({"relation_id": "R0002"}, "无效或重复"),
    ({"src_id": "KG999"}, "关系端点不存在"),
    ({"weight": 1.5}, "weight"),
    ({"relation_type": "爱上"}, "relation_type 无效"),
    ({"sources": []}, "缺少关系对应的 HIS 来源"),
])
def test_bad_relation_is_rejected(graph, mutation, message):
    data = load_raw_sample()
    data["relations"][0] = {**data["relations"][0], **mutation}
    with pytest.raises(ValueError, match=message):
        KnowledgeGraph(data)


def test_sample_accepts_boolean_verified():
    data = load_raw_sample()
    for record in (*data["entities"], *data["relations"]):
        record["verified"] = False
    graph = KnowledgeGraph(data)
    assert graph.entities["KG001"]["verified"] == 0


@pytest.mark.parametrize("value, expected", [
    (2001, (date(2001, 1, 1), date(2001, 12, 31))),
    ("2001", (date(2001, 1, 1), date(2001, 12, 31))),
    ("2001年", (date(2001, 1, 1), date(2001, 12, 31))),
    ("2001-05-06", (date(2001, 5, 6), date(2001, 5, 6))),
    ("2001年5月", (date(2001, 5, 1), date(2001, 5, 28))),
    ("2001年5月6日", (date(2001, 5, 6), date(2001, 5, 6))),
    ("1990年代", (date(1990, 1, 1), date(1999, 12, 31))),
    ("1990-2000", (date(1990, 1, 1), date(2000, 12, 31))),
    ("2001年13月", None),
    ("2000-1990", None),
    ("2001-13-01", None),
    ("2026-11-22T09:30:00+08:00", (date(2026, 11, 22), date(2026, 11, 22))),
    ("2026-11-22T09:30:00", None),  # naive timestamps are ambiguous, ignored
    ("早期", None),
    (None, None),
    ([], None),
])
def test_parse_period(value, expected):
    assert parse_period(value) == expected


def test_entity_period_reads_contract_time_fields(graph):
    assert entity_period(graph.entities["KG001"]) == (date(2001, 1, 1), date(2001, 12, 31))
    assert entity_period(graph.entities["KG006"]) is None


def test_incident_unknown_entity_raises(graph):
    with pytest.raises(KeyError):
        graph.incident("KG999")


def test_storyline_traces_back_to_graph_edges(graph):
    story = storyline_dict(graph, length=5)
    assert len(story["nodes"]) == 5
    for node in story["nodes"]:
        assert node["entity_id"] in graph.entities
    for transition in story["transitions"]:
        relation = graph.find_relation(
            transition["from"], transition["to"], transition["relation_type"],
            reversed=transition["reversed"], relation_id=transition["relation_id"],
        )
        assert relation is not None, "每个转场必须对应图谱中真实存在的关系"
    # Every citation is a KG entity or a registered HIS id.
    for citation in story["source_citations"]:
        assert citation in graph.entities or citation in graph.history_ids
