"""Output files must satisfy the documented structural contract.

(Contract allows only stdlib + numpy/pandas/scikit-learn/scipy/pytest/requests,
so this validates the key structural rules by hand instead of via jsonschema.)
"""

import json
import re

from conftest import PACKAGE

ID_PATTERNS = {
    "KG": re.compile(r"^KG[0-9]{3,}$"), "R": re.compile(r"^R[0-9]{3,}$"),
    "HIS": re.compile(r"^HIS[0-9]{3,}$"), "LD": re.compile(r"^LD[0-9]{3,}$"),
}
ENTITY_TYPES = {"building", "person", "event", "artifact", "craft",
                "merchant", "place", "institution", "period"}
RELATION_TYPES = {"built_by", "located_in", "participated_in", "heritage_of",
                  "owned_by", "named_after", "related_to", "succeeded"}
RULE_IDS = {"KG_ENTITY", "KG_RELATION", "KG_TIME", "KG_TYPE", "KG_CITATION",
            "KG_WORDING", "KG_CHAIN", "KG_LLM"}


def _check_ids(record, fields):
    for field, prefix in fields.items():
        value = record.get(field)
        assert value is None or (isinstance(value, str)
                                 and ID_PATTERNS[prefix].match(value)), (field, value)


def test_sample_graph_matches_schema_rules():
    with (PACKAGE / "data" / "kg_sample.json").open(encoding="utf-8") as stream:
        data = json.load(stream)
    assert data["source"] == "sample"
    for entity in data["entities"]:
        _check_ids(entity, {"entity_id": "KG", "point_id": "LD"})
        assert entity["entity_type"] in ENTITY_TYPES
        assert entity["verified"] in (0, False)
        assert all(ID_PATTERNS["HIS"].match(s) for s in entity["sources"])
    ids = [entity["entity_id"] for entity in data["entities"]]
    assert len(set(ids)) == len(ids)
    for relation in data["relations"]:
        _check_ids(relation, {"relation_id": "R", "src_id": "KG", "dst_id": "KG"})
        assert relation["relation_type"] in RELATION_TYPES
        assert 0 <= relation["weight"] <= 1
        assert relation["sources"]
    assert len(data["entities"]) >= 20 and len(data["relations"]) >= 40


def _load_output(output_dir, name):
    with (output_dir / name).open(encoding="utf-8") as stream:
        return json.load(stream)


def test_recommend_result_matches_schema_rules(pipeline_output):
    result = _load_output(pipeline_output, "kg_recommend_result.json")
    assert ID_PATTERNS["KG"].match(result["source_entity_id"])
    assert isinstance(result["algo_version"], str)
    for item in result["items"]:
        _check_ids(item, {"entity_id": "KG"})
        assert item["entity_type"] in ENTITY_TYPES
        assert item["reasons"] and item["path"]
        assert all(rel in RELATION_TYPES for rel in item["path"])
        assert 0 <= item["score"] <= 1
        for edge in item["path_edges"]:
            _check_ids(edge, {"from": "KG", "to": "KG", "relation_id": "R"})
            assert edge["relation_type"] in RELATION_TYPES
            assert isinstance(edge["reversed"], bool)


def test_storyline_output_matches_schema_rules(pipeline_output):
    story = _load_output(pipeline_output, "storyline.json")
    assert story["nodes"] and story["transitions"]
    for node in story["nodes"]:
        _check_ids(node, {"entity_id": "KG"})
        assert node["role"] in ("anchor", "related")
        assert node["one_line"]
    for transition in story["transitions"]:
        _check_ids(transition, {"from": "KG", "to": "KG", "relation_id": "R"})
        assert transition["relation_type"] in RELATION_TYPES
        assert transition["connector_text"]
    for citation in story["source_citations"]:
        assert ID_PATTERNS["KG"].match(citation) or ID_PATTERNS["HIS"].match(citation)


def test_consistency_report_matches_schema_rules(pipeline_output):
    report = _load_output(pipeline_output, "consistency_report.json")
    assert isinstance(report["passed"], bool)
    assert set(report["rule_hits"]) == RULE_IDS
    for issue in report["issues"]:
        assert issue["level"] in ("error", "warn")
        assert issue["rule_id"] in RULE_IDS
        assert issue["target"] and issue["evidence"] and issue["suggestion"]


def test_metrics_contains_required_sections(pipeline_output):
    metrics = _load_output(pipeline_output, "metrics.json")
    assert metrics["graph_source"] == "sample"
    assert metrics["recommendation_ctr_proxy"]["data_source"] == "synthetic"
    for arm in ("semantic", "tag_popularity"):
        arm_metrics = metrics["recommendation_ctr_proxy"][arm]
        assert {"clicks", "impressions", "ctr"} <= set(arm_metrics)
    assert metrics["storyline_lengths"]["stories_evaluated"] > 0
    assert set(metrics["consistency"]["rule_hits"]) == RULE_IDS
