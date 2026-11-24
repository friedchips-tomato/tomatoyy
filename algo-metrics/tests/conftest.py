"""pytest 引导：把 ``algo-metrics/`` 放进 sys.path，使测试能直接 import 框架模块。

用法（仓库根目录执行）::

    python -m pytest algo-metrics/tests -q
"""

from __future__ import annotations

import sys
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parents[1]
if str(PKG_DIR) not in sys.path:
    sys.path.insert(0, str(PKG_DIR))
