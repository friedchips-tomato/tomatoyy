# -*- coding: utf-8 -*-
"""pytest 公共夹具：把包目录加入 sys.path 并加载示例数据。"""
import json
import sys
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]
if str(PKG) not in sys.path:
    sys.path.insert(0, str(PKG))

DATA = PKG / "data"


@pytest.fixture(scope="session")
def guides():
    return json.loads((DATA / "guides.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def points():
    return json.loads((DATA / "points.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def reviews():
    import profile
    return profile.load_reviews()


@pytest.fixture(scope="session")
def events():
    import profile
    return profile.load_events()


@pytest.fixture(scope="session")
def ctx(guides, points, reviews, events):
    import matching
    return matching.build_context(guides, points, reviews, events)
