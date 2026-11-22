"""Pytest helpers: load the sample graph once per session."""

import json
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parent.parent
if str(PACKAGE) not in sys.path:
    sys.path.insert(0, str(PACKAGE))

from graph import KnowledgeGraph  # noqa: E402


@pytest.fixture(scope="session")
def graph():
    return KnowledgeGraph.load(PACKAGE / "data" / "kg_sample.json")


def load_raw_sample():
    """Load the sample graph as a plain dict, for mutation tests."""
    with (PACKAGE / "data" / "kg_sample.json").open(encoding="utf-8-sig") as stream:
        return json.load(stream)


def storyline_dict(graph, **overrides):
    """A minimal storyline for the first building, easy to mutate in tests."""
    from storyline import generate_storyline

    kwargs = {"length": 3, "theme": "侨乡"}
    kwargs.update(overrides)
    return generate_storyline(graph, "KG001", **kwargs)
