"""浏览器产物导出脚本的可复现性回归（验收：脚本可重复执行 + 与入库产物一致）。

被测脚本：``parking-forecast/scripts/export_browser.mjs``
  * 重新生成 ``prototype-paper/data/parking-artifact.js`` 与 ``prototype-paper/data/parking-runtime.js``；
  * 自检 data_fingerprint / 内联 model+dataset / runtime 函数体 / 适配层与 runtime/index.mjs 行为一致。

本文件只做「跑脚本 + 比对」的外围断言；真正的算法校验在脚本内部（Node 侧零依赖）。
若环境没有 Node，本文件整体跳过（Node 是阶段 2 运行时测试的前提）。
"""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from pathlib import Path

import pytest

PF_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PF_DIR.parent
SCRIPT = PF_DIR / "scripts" / "export_browser.mjs"
ARTIFACT = REPO_ROOT / "prototype-paper" / "data" / "parking-artifact.js"
RUNTIME = REPO_ROOT / "prototype-paper" / "data" / "parking-runtime.js"

NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="需要 Node（阶段 2 运行时测试的同一前提）")

SHA_LINE = re.compile(r"重新生成 sha256 = ([0-9a-f]{64})")


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [NODE, str(SCRIPT), *args],
        cwd=str(PF_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _normalize(text: str) -> str:
    """产物在 Git 中以 LF 存储；检出环境可能是 CRLF，比对前统一行尾。"""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_script_exists() -> None:
    assert SCRIPT.is_file(), f"缺少导出脚本 {SCRIPT}"


def test_check_mode_passes() -> None:
    """--check：重新生成的产物与入库产物一致，且脚本内置自检全部通过。"""
    proc = _run("--check")
    assert proc.returncode == 0, f"--check 失败\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    assert "自检：全部通过" in proc.stdout, proc.stdout
    assert proc.stdout.count("与磁盘文件比对：一致") == 2, proc.stdout


def test_generated_matches_committed_artifacts() -> None:
    """脚本报告的 sha256 必须等于入库产物（行尾归一化后）的 sha256。"""
    proc = _run("--check")
    assert proc.returncode == 0, proc.stderr
    hashes = SHA_LINE.findall(proc.stdout)
    assert len(hashes) == 2, proc.stdout
    assert hashes[0] == _sha256(_normalize(ARTIFACT.read_text(encoding="utf-8")))
    assert hashes[1] == _sha256(_normalize(RUNTIME.read_text(encoding="utf-8")))


def test_generation_is_deterministic() -> None:
    """连续跑两次，产出的字节必须完全相同。"""
    first = _run("--check")
    second = _run("--check")
    assert first.returncode == 0 and second.returncode == 0
    assert SHA_LINE.findall(first.stdout) == SHA_LINE.findall(second.stdout)
    assert first.stdout == second.stdout


def test_runtime_bundle_is_classic_script() -> None:
    """产物必须是经典脚本（IIFE），不能改成 .mjs ESM —— http.server 会把 .mjs 当 text/plain。"""
    text = _normalize(RUNTIME.read_text(encoding="utf-8"))
    assert text.startswith("// 停车运行时"), text[:60]
    assert "(function (global) {" in text
    assert text.rstrip().endswith('})(typeof window !== "undefined" ? window : globalThis);')
    # 打包后的代码里不应残留 ESM 语法
    assert not re.search(r"^import\s", text, re.M), "运行时包里残留 import"
    assert not re.search(r"^export\s", text, re.M), "运行时包里残留 export"
