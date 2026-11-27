"""Run the recommendation, storyline, consistency, and proxy evaluation pipeline."""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from consistency import HttpLLMChecker, consistency_report
from evaluation import evaluate_ctr
from graph import ALGO_VERSION, ENTITY_LABELS, KnowledgeGraph
from recommend import recommend
from storyline import STORY_LENGTHS, generate_storyline

PACKAGE = Path(__file__).resolve().parent
BENCHMARK_THEMES = ("侨乡", "非遗", "档案")


def _write_json(output_dir, filename, data):
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    (output_dir / filename).write_text(payload, encoding="utf-8")


def _measure_storylines(graph):
    buildings = sorted(node for node, entity in graph.entities.items()
                       if entity["entity_type"] == "building")
    distribution = {}
    for length in STORY_LENGTHS:
        lengths = Counter()
        for building in buildings:
            for theme in BENCHMARK_THEMES:
                story = generate_storyline(graph, building, length, theme)
                lengths[len(story["nodes"])] += 1
        distribution[str(length)] = dict(sorted(lengths.items()))
    return {
        "building_count": len(buildings), "themes": list(BENCHMARK_THEMES),
        "stories_evaluated": len(buildings) * len(BENCHMARK_THEMES) * len(STORY_LENGTHS),
        "requested_to_actual": distribution,
    }


def _print_results(recommendation, story, report, metrics):
    print(f"关联推荐：{recommendation['source_entity_id']}")
    for group, label in (("building", "建筑"), ("person", "人物"), ("event", "事件"),
                         ("cultural_resource", "文化资源")):
        print(f"  {label}")
        for item in recommendation["items"]:
            if item["recommendation_group"] != group:
                continue
            path = " / ".join(item["path"])
            kind = ENTITY_LABELS[item["entity_type"]]
            print(f"  - {item['display_name']}（{kind}，{item['entity_id']}）"
                  f" {item['score']:.3f}｜{path}")
            for reason in item["reasons"]:
                print(f"    {reason}")
    print(f"\n故事线（{len(story['nodes'])} 点）：{story['title']}")
    for index, node in enumerate(story["nodes"]):
        if index:
            print(f"   {story['transitions'][index - 1]['connector_text']}")
        print(f"  {index + 1}. {node['one_line']} {node['reason']}")
    print(f"  引用：{'、'.join(story['source_citations'])}")
    print(f"\n一致性校验：{'通过' if report['passed'] else '有错误'}，"
          f"共 {len(report['issues'])} 项")
    for issue in report["issues"]:
        print(f"  {issue['level']} {issue['rule_id']} {issue['target']}：{issue['evidence']} "
              f"{issue['suggestion']}")
    print("\n推荐点击率代理（合成事件）")
    for arm, name in (("semantic", "语义排序"), ("tag_popularity", "标签热度基线")):
        result = metrics["recommendation_ctr_proxy"][arm]
        ctr = f"{result['ctr']:.2%}" if result["ctr"] is not None else "无展示"
        print(f"  {name}：{result['clicks']}/{result['impressions']} = {ctr}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="知识图谱推荐、故事线和校验示例")
    parser.add_argument("--graph", type=Path, default=PACKAGE / "data" / "kg_sample.json")
    parser.add_argument("--building", default="KG001")
    parser.add_argument("--length", type=int, choices=STORY_LENGTHS, default=5)
    parser.add_argument("--theme", default="侨乡")
    parser.add_argument("--output-dir", type=Path, default=PACKAGE / "output")
    parser.add_argument("--llm", action="store_true", help="在离线规则之后请求配置的 LLM")
    args = parser.parse_args(argv)
    try:
        graph = KnowledgeGraph.load(args.graph)
        story = generate_storyline(graph, args.building, args.length, args.theme)
        recommendation = recommend(graph, args.building)
        checker = HttpLLMChecker() if args.llm else None
        report = consistency_report(story, graph, checker)
        args.output_dir.mkdir(parents=True, exist_ok=True)
        metrics = {
            "algo_version": ALGO_VERSION,
            "graph_source": graph.source,
            "graph_size": {
                "entities": len(graph.entities), "relations": len(graph.relations),
                "distinct_point_ids": len({entity["point_id"] for entity in graph.entities.values()
                                           if entity.get("point_id")}),
            },
            "recommendation_ctr_proxy": evaluate_ctr(graph, args.output_dir),
            "storyline_lengths": _measure_storylines(graph),
            "consistency": {
                "story_count": 1, "passed": report["passed"], "rule_hits": report["rule_hits"],
            },
        }
        for filename, payload in (
            ("kg_recommend_result.json", recommendation), ("storyline.json", story),
            ("consistency_report.json", report), ("metrics.json", metrics),
        ):
            _write_json(args.output_dir, filename, payload)
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.error(str(error))
    _print_results(recommendation, story, report, metrics)
    print(f"\n输出目录：{args.output_dir.resolve()}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
