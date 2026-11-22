"""Consistency rules: every rule fires on a deliberately broken storyline."""

import pytest

from conftest import storyline_dict
from consistency import HttpLLMChecker, RuleOnlyChecker, consistency_report


def issues_by_rule(report):
    return {issue["rule_id"] for issue in report["issues"]}


def test_valid_storyline_has_no_errors(graph):
    story = storyline_dict(graph, length=5)
    report = consistency_report(story, graph)
    assert report["passed"], [i for i in report["issues"] if i["level"] == "error"]
    assert report["rule_hits"]["KG_ENTITY"] == 0
    # A warn from wording is fine (the sample mentions 据说 on purpose).
    assert report["rule_hits"]["KG_WORDING"] >= 1


def test_missing_entity_is_reported(graph):
    story = storyline_dict(graph)
    story["nodes"][1] = {**story["nodes"][1], "entity_id": "KG999"}
    report = consistency_report(story, graph)
    assert not report["passed"]
    assert any(
        issue["rule_id"] == "KG_ENTITY" and "KG999" in issue["evidence"]
        for issue in report["issues"]
    )


def test_entity_referenced_in_text_but_missing_from_graph(graph):
    story = storyline_dict(graph)
    story["nodes"][0]["one_line"] += "相关条目 KG888 值得一看。"
    report = consistency_report(story, graph)
    assert "KG_ENTITY" in issues_by_rule(report)


def test_nonexistent_relation_is_reported(graph):
    story = storyline_dict(graph, length=5)
    story["transitions"][0]["relation_type"] = "succeeded"
    report = consistency_report(story, graph)
    assert not report["passed"]
    assert "KG_RELATION" in issues_by_rule(report)


def test_relation_id_mismatch_is_reported(graph):
    story = storyline_dict(graph, length=5)
    story["transitions"][0]["relation_id"] = "R0049"
    report = consistency_report(story, graph)
    assert "KG_RELATION" in issues_by_rule(report)


def test_broken_chain_is_reported(graph):
    story = storyline_dict(graph, length=5)
    story["transitions"][1]["from"], story["transitions"][1]["to"] = (
        story["transitions"][1]["to"], story["transitions"][1]["from"],
    )
    report = consistency_report(story, graph)
    assert "KG_CHAIN" in issues_by_rule(report)


def test_type_incompatible_relation_is_reported(graph):
    story = storyline_dict(graph)
    # Inject a type-incompatible triple into the graph (event —built_by→ building
    # cannot exist per RELATION_TYPES), then let the story claim it.
    broken = {
        "relation_id": "R9901", "src_id": "KG010", "dst_id": "KG001",
        "relation_type": "built_by", "weight": 0.5, "sources": ["HIS001"], "verified": 0,
    }
    graph.relations["R9901"] = broken
    graph._triples["KG010", "KG001", "built_by"].append("R9901")
    try:
        node = story["nodes"][1]
        story["nodes"][1]["entity_id"] = "KG010"
        story["transitions"][0] = {
            **story["transitions"][0], "from": "KG001", "to": "KG010",
            "relation_type": "built_by", "reversed": True, "relation_id": "R9901",
        }
        report = consistency_report(story, graph)
        assert "KG_TYPE" in issues_by_rule(report)
    finally:
        del graph.relations["R9901"]
        graph._triples["KG010", "KG001", "built_by"].remove("R9901")


def test_time_contradiction_in_node_order_is_reported(graph):
    story = storyline_dict(graph, length=5)
    # KG004 (2007) placed before KG001 (2001): anachronistic ordering.
    ordered = ["KG001", "KG004", "KG002", "KG003", "KG005"]
    for index, entity_id in enumerate(ordered):
        story["nodes"][index]["entity_id"] = entity_id
    for index in range(4):
        story["transitions"][index] = {
            **story["transitions"][index], "from": ordered[index], "to": ordered[index + 1],
            "relation_type": "related_to", "reversed": False, "relation_id": None,
        }
    report = consistency_report(story, graph)
    assert not report["passed"]
    assert "KG_TIME" in issues_by_rule(report)


def test_time_contradiction_in_text_is_reported(graph):
    story = storyline_dict(graph)
    story["nodes"][0]["one_line"] = "示例工坊丙晚于示例展馆丁，堪称一绝。"
    story["nodes"][0]["reason"] = ""
    report = consistency_report(story, graph)
    assert "KG_TIME" in issues_by_rule(report)


def test_time_contradiction_requires_registered_periods(graph):
    story = storyline_dict(graph)
    story["nodes"][0]["one_line"] = "示例骑楼甲晚于示例商栈乙。"
    story["nodes"][0]["reason"] = ""
    report = consistency_report(story, graph)
    assert "KG_TIME" in issues_by_rule(report)


def test_missing_citation_is_reported(graph):
    story = storyline_dict(graph)
    story["source_citations"] = ["KG404"]
    report = consistency_report(story, graph)
    assert not report["passed"]
    assert "KG_CITATION" in issues_by_rule(report)


def test_empty_citation_is_reported(graph):
    story = storyline_dict(graph)
    story["source_citations"] = []
    report = consistency_report(story, graph)
    assert "KG_CITATION" in issues_by_rule(report)


def test_risk_words_are_flagged(graph):
    story = storyline_dict(graph)
    story["nodes"][0]["one_line"] = "这里是全国最高的骑楼，据说独一无二。"
    story["nodes"][0]["reason"] = ""
    report = consistency_report(story, graph)
    wording = [i for i in report["issues"] if i["rule_id"] == "KG_WORDING"]
    assert wording and wording[0]["level"] == "warn"


def test_rule_hits_cover_all_ids(graph):
    report = consistency_report(storyline_dict(graph), graph)
    assert set(report["rule_hits"]) == set(RuleOnlyChecker.__module__ and [
        "KG_ENTITY", "KG_RELATION", "KG_TIME", "KG_TYPE", "KG_CITATION",
        "KG_WORDING", "KG_CHAIN", "KG_LLM",
    ])


def test_http_checker_falls_back_without_env(graph, monkeypatch, capsys):
    for var in ("ALGO_LLM_BASE_URL", "ALGO_LLM_API_KEY", "ALGO_LLM_MODEL"):
        monkeypatch.delenv(var, raising=False)
    story = storyline_dict(graph)
    checker = HttpLLMChecker()
    issues = checker.check(story, graph)
    captured = capsys.readouterr()
    assert "规则校验" in captured.err
    # Falls back to exactly the rule-layer result.
    assert issues == RuleOnlyChecker().check(story, graph)


def test_http_checker_partial_config_falls_back(graph, monkeypatch, capsys):
    monkeypatch.setenv("ALGO_LLM_BASE_URL", "https://api.example.com/v1")
    monkeypatch.delenv("ALGO_LLM_API_KEY", raising=False)
    story = storyline_dict(graph)
    issues = HttpLLMChecker().check(story, graph)
    assert issues == RuleOnlyChecker().check(story, graph)
    assert "规则校验" in capsys.readouterr().err


def test_http_checker_survives_request_failure(graph, monkeypatch, capsys):
    monkeypatch.setenv("ALGO_LLM_BASE_URL", "https://api.example.com/v1")
    monkeypatch.setenv("ALGO_LLM_API_KEY", "dummy")
    monkeypatch.setenv("ALGO_LLM_MODEL", "dummy")

    import consistency

    def boom(*args, **kwargs):
        raise ConnectionError("network down")

    monkeypatch.setattr(consistency.requests, "post", boom)
    story = storyline_dict(graph)
    issues = HttpLLMChecker().check(story, graph)
    assert issues == RuleOnlyChecker().check(story, graph)
    assert "保留离线规则结果" in capsys.readouterr().err
