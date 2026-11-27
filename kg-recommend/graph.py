"""Index the interchange graph and expose traversals with their original edge direction."""

import json
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

ALGO_VERSION = "kg-recommend-0.1.0"
ENTITY_LABELS = {
    "building": "建筑", "person": "人物", "event": "事件", "artifact": "文物", "craft": "非遗",
    "merchant": "商业业态", "place": "地点", "institution": "机构", "period": "时期",
}
ENTITY_TYPES = tuple(ENTITY_LABELS)
START_TYPES = ("building", "person")
RECOMMENDATION_GROUPS = {
    "building": "building", "person": "person", "event": "event",
    "artifact": "cultural_resource", "craft": "cultural_resource",
}


@dataclass(frozen=True)
class RelationSpec:
    weight: float
    src_types: tuple
    dst_types: tuple
    phrase: str
    label: str


RELATION_TYPES = {
    "built_by": RelationSpec(
        1.0, ("building",), ("person", "institution", "merchant"), "{src}由{dst}建造", "建造者",
    ),
    "located_in": RelationSpec(0.65, ENTITY_TYPES, ("place", "building"), "{src}位于{dst}", "位于"),
    "participated_in": RelationSpec(
        0.95, ("person", "institution", "merchant"), ("event",), "{src}参与了{dst}", "参与",
    ),
    "heritage_of": RelationSpec(
        0.9, ("artifact", "craft"), ENTITY_TYPES, "{src}的传承与{dst}有关", "传承关联",
    ),
    "owned_by": RelationSpec(
        0.85, ("building", "artifact", "craft", "merchant"),
        ("person", "institution", "merchant"), "{src}归{dst}所有", "所有者",
    ),
    "named_after": RelationSpec(0.8, ENTITY_TYPES, ENTITY_TYPES, "{src}以{dst}命名", "得名于"),
    "related_to": RelationSpec(0.5, ENTITY_TYPES, ENTITY_TYPES, "{src}与{dst}相关", "相关"),
    "succeeded": RelationSpec(0.85, ENTITY_TYPES, ENTITY_TYPES, "{src}承继了{dst}", "承继"),
}


def id_matches(value, prefix):
    return isinstance(value, str) and bool(re.fullmatch(rf"{prefix}[0-9]{{3,}}", value))


def history_refs(record):
    return {source for source in record["sources"] if id_matches(source, "HIS")}


@dataclass(frozen=True)
class Step:
    origin: str
    destination: str
    relation_id: str
    relation_type: str
    reversed: bool

    def as_dict(self):
        return {
            "from": self.origin,
            "to": self.destination,
            "relation_id": self.relation_id,
            "relation_type": self.relation_type,
            "reversed": self.reversed,
        }


class KnowledgeGraph:
    def __init__(self, data):
        self.version = data["version"]
        self.source = data["source"]
        self.entities = {}
        self.relations = {}
        self._adjacency = defaultdict(list)
        self._triples = defaultdict(list)
        self.history_ids = set(data.get("history_ids", []))
        if any(not id_matches(history_id, "HIS") for history_id in self.history_ids):
            raise ValueError("history_ids 必须由 HIS 编号组成")
        if not isinstance(self.version, str) or not self.version:
            raise ValueError("version 必须是非空字符串")
        if not isinstance(self.source, str) or not self.source:
            raise ValueError("source 必须是非空字符串")
        for entity in data["entities"]:
            entity_id = entity["entity_id"]
            self._check_id(entity_id, "KG", self.entities)
            point_id = entity.get("point_id")
            if point_id is not None and not id_matches(point_id, "LD"):
                raise ValueError(f"{entity_id} 的 point_id 无效")
            if entity["entity_type"] not in ENTITY_TYPES:
                raise ValueError(f"{entity_id} 的 entity_type 无效")
            self._check_record(entity, entity_id)
            self.history_ids.update(entity["sources"])
            if not isinstance(entity["name"], str) or not entity["name"].strip():
                raise ValueError(f"{entity_id} 的 name 必须是非空字符串")
            if (not isinstance(entity["tags"], list)
                    or not all(isinstance(tag, str) for tag in entity["tags"])):
                raise ValueError(f"{entity_id} 的 tags 必须是字符串数组")
            if not isinstance(entity["attributes"], dict):
                raise ValueError(f"{entity_id} 的 attributes 必须是 JSON 对象")
            if entity["summary"] is not None and not isinstance(entity["summary"], str):
                raise ValueError(f"{entity_id} 的 summary 必须是字符串或 null")
            self.entities[entity_id] = entity
        for relation in data["relations"]:
            relation_id = relation["relation_id"]
            self._check_id(relation_id, "R", self.relations)
            src, dst = relation["src_id"], relation["dst_id"]
            if src not in self.entities or dst not in self.entities:
                raise ValueError(f"{relation_id} 的关系端点不存在")
            weight = relation["weight"]
            if type(weight) not in (int, float) or not 0 <= weight <= 1:
                raise ValueError(f"{relation_id} 的 weight 必须在 0 到 1 之间")
            self._check_record(relation, relation_id)
            if not relation["sources"]:
                raise ValueError(f"{relation_id} 缺少关系对应的 HIS 来源")
            self.history_ids.update(relation["sources"])
            kind = relation["relation_type"]
            if kind not in RELATION_TYPES:
                raise ValueError(f"{relation_id} 的 relation_type 无效")
            self.relations[relation_id] = relation
            self._triples[src, dst, kind].append(relation_id)
            self._adjacency[src].append(Step(src, dst, relation_id, kind, False))
            if src != dst:
                self._adjacency[dst].append(Step(dst, src, relation_id, kind, True))
        for steps in self._adjacency.values():
            steps.sort(key=lambda step: (step.destination, step.relation_id))

    @staticmethod
    def _check_id(value, prefix, index):
        if not id_matches(value, prefix) or value in index:
            raise ValueError(f"无效或重复的 {prefix} ID：{value}")

    def _check_record(self, record, record_id):
        verified = record["verified"]
        if isinstance(verified, bool):
            verified = int(verified)
            record["verified"] = verified
        if type(verified) is not int or verified not in (0, 1):
            raise ValueError(f"{record_id} 的 verified 必须是 0/1 或布尔值")
        if self.source == "sample" and verified != 0:
            raise ValueError(f"{record_id} 的示例内容必须标注 verified=0")
        sources = record["sources"]
        if not isinstance(sources, list) or not all(id_matches(ref, "HIS") for ref in sources):
            raise ValueError(f"{record_id} 的 sources 必须是 HIS 编号数组")

    @classmethod
    def load(cls, filename):
        with Path(filename).open(encoding="utf-8-sig") as source:
            return cls(json.load(source))

    def incident(self, entity_id):
        """Yield outgoing and incoming edges in a stable order."""
        if entity_id not in self.entities:
            raise KeyError(f"实体不存在：{entity_id}")
        return iter(self._adjacency.get(entity_id, ()))

    def compatible(self, relation):
        """Check the original triple, regardless of the traversal direction."""
        kind = relation["relation_type"]
        spec = RELATION_TYPES[kind]
        src_type = self.entities[relation["src_id"]]["entity_type"]
        dst_type = self.entities[relation["dst_id"]]["entity_type"]
        if kind == "succeeded":
            return src_type == dst_type
        return src_type in spec.src_types and dst_type in spec.dst_types

    def find_relation(self, origin, destination, kind, *, reversed=False, relation_id=None):
        src, dst = (destination, origin) if reversed else (origin, destination)
        matches = self._triples.get((src, dst, kind), ())
        if relation_id is None:
            relation_id = min(matches, default=None)
        return self.relations[relation_id] if relation_id in matches else None

    def short_paths(self, source):
        """Return every simple one- or two-hop path, grouped by destination."""
        paths = defaultdict(list)
        for first in self.incident(source):
            if first.destination == source or self.compatible(self.relations[first.relation_id]) is False:
                continue
            paths[first.destination].append((first,))
            for second in self.incident(first.destination):
                if second.destination in (source, first.destination):
                    continue
                if self.compatible(self.relations[second.relation_id]) is not False:
                    paths[second.destination].append((first, second))
        return paths
