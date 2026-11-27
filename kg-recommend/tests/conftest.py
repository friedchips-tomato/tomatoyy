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


@pytest.fixture(scope="session")
def pipeline_output(tmp_path_factory):
    """Run the real `main.py` pipeline once into an isolated temp directory.

    The schema tests assert on the exact artifacts `main.py` emits, so they
    must be produced by the pipeline itself rather than committed to the repo.
    This keeps a clean checkout green and lets `output/` stay gitignored.
    """
    import main as main_module

    output_dir = tmp_path_factory.mktemp("kg-recommend-output")
    main_module.main(["--output-dir", str(output_dir)])
    return output_dir


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
