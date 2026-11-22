"""Proxy click-through-rate evaluation over synthetic browsing events."""

import csv

from evaluation import evaluate_ctr

EXPECTED_FIELDS = (
    "visitor_id", "ts", "event_type", "point_id", "route_id", "dwell_seconds",
    "interest_tags", "device_lang", "data_source", "source_entity_id",
    "target_entity_id", "rank",
)


def test_evaluate_ctr_runs_deterministically(graph, tmp_path):
    first = evaluate_ctr(graph, tmp_path)
    second = evaluate_ctr(graph, tmp_path)
    assert first == second, "固定种子下代理评估必须可复现"


def test_evaluate_ctr_metrics(graph, tmp_path):
    metrics = evaluate_ctr(graph, tmp_path)
    assert metrics["data_source"] == "synthetic"
    assert metrics["visitors_per_arm"] >= 100
    for arm in ("semantic", "tag_popularity"):
        arm_metrics = metrics[arm]
        assert arm_metrics["impressions"] > 0
        assert 0 <= arm_metrics["clicks"] <= arm_metrics["impressions"]
        assert abs(arm_metrics["ctr"] - round(
            arm_metrics["clicks"] / arm_metrics["impressions"], 6)) < 1e-9


def test_evaluate_ctr_semantic_beats_baseline(graph, tmp_path):
    metrics = evaluate_ctr(graph, tmp_path)
    assert metrics["absolute_ctr_delta"] == round(
        metrics["semantic"]["ctr"] - metrics["tag_popularity"]["ctr"], 6)
    assert metrics["absolute_ctr_delta"] > 0, (
        "语义排序应稳定优于标签热度基线（同一用户配对抽样）")


def test_evaluate_ctr_writes_event_csv(graph, tmp_path):
    evaluate_ctr(graph, tmp_path)
    for arm in ("semantic", "tag_popularity"):
        path = tmp_path / f"visitor_events_{arm}.csv"
        with path.open(encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
        assert rows
        assert set(rows[0]) == set(EXPECTED_FIELDS)
        assert {row["event_type"] for row in rows} <= {
            "view_recommendation", "click_recommendation"}
        assert all(row["data_source"] == "synthetic" for row in rows)
        assert all(row["visitor_id"].startswith("V") for row in rows)


def test_evaluate_ctr_empty_graph(tmp_path):
    from graph import KnowledgeGraph

    empty = KnowledgeGraph({
        "version": "1.0.0", "source": "sample", "entities": [], "relations": [],
    })
    metrics = evaluate_ctr(empty, tmp_path)
    assert metrics["visitors_per_arm"] == 0
    assert metrics["semantic"]["ctr"] is None
