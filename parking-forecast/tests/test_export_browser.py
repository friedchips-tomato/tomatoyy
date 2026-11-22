"""浏览器产物导出脚本的可复现性回归 + 生成物行尾策略回归。

被测脚本：``parking-forecast/scripts/export_browser.mjs``
  * 重新生成 ``prototype-paper/data/parking-artifact.js`` 与 ``prototype-paper/data/parking-runtime.js``；
  * 自检 data_fingerprint / 内联 model+dataset / runtime 函数体 / 适配层与 runtime/index.mjs 行为一致。

另覆盖三件验收里实测出来的缺陷：
  1. 适配层 ``demoNow()`` 的正则漏 ``\\d`` 转义 → ``CD_PARKING_DEMO_NOW`` 覆盖开关静默失效；
  2. 生成物按 CRLF 落盘 → 磁盘字节与 Git blob 不一致，manifest 里记的哈希对不上；
  3. ``export_browser.mjs`` 的自检注释与行尾方向。

本文件只做「跑脚本 + 比对」的外围断言；真正的算法校验在脚本内部（Node 侧零依赖）。
若环境没有 Node，本文件整体跳过（Node 是阶段 2 运行时测试的前提）。
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

PF_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PF_DIR.parent
SCRIPT = PF_DIR / "scripts" / "export_browser.mjs"
ADAPTER = PF_DIR / "scripts" / "browser_adapter.js"
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


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------- #
# 导出脚本本身
# --------------------------------------------------------------------------- #


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


# --------------------------------------------------------------------------- #
# 缺陷一：demoNow() 正则漏转义 → 演示时间覆盖开关静默失效
# --------------------------------------------------------------------------- #


def test_demo_now_regex_uses_escaped_digit_class() -> None:
    """产物里的 demoNow() 正则必须含 \\d，不能是裸 d（裸 d 永远匹配不上真实时间戳）。"""
    runtime = _normalize(RUNTIME.read_text(encoding="utf-8"))
    assert r"/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/" in runtime, "demoNow() 的正则没有 \\d 转义"
    assert r"/^d{4}-d{2}-d{2}Td{2}:d{2}:d{2}/" not in runtime, "demoNow() 的正则仍是漏转义的旧写法"
    adapter = _normalize(ADAPTER.read_text(encoding="utf-8"))
    assert r"/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/" in adapter, "适配层模板里的正则没有 \\d 转义"


def test_demo_now_regex_matches_real_timestamp() -> None:
    """把产物里的正则抠出来实测：对真实形态的时间戳必须匹配成功。"""
    runtime = _normalize(RUNTIME.read_text(encoding="utf-8"))
    match = re.search(r"/\^(\\d\{4\}-\\d\{2\}-\\d\{2\}T\\d\{2\}:\\d\{2\}:\\d\{2\})/", runtime)
    assert match, "产物里找不到 demoNow() 的时间戳正则"
    pattern = re.compile(match.group(1))
    assert pattern.match("2026-04-10T14:00:00+08:00"), "正则匹配不上真实时间戳"
    assert not pattern.match("not-a-timestamp")


def test_demo_now_override_actually_takes_effect() -> None:
    """端到端：在打包产物里设置 CD_PARKING_DEMO_NOW，demoNow() 必须返回它。

    覆盖值必须与 DEMO_NOW（2026-04-10T14:00:00+08:00）不同，否则「开关生效」与
    「开关失效」观测不到区别——这正是原 bug 能藏住的原因。
    """
    override = "2026-05-20T09:30:00+08:00"
    script = (
        "const fs=require('node:fs'),vm=require('node:vm');"
        f"const src=fs.readFileSync({json.dumps(str(RUNTIME))},'utf8');"
        "const sandbox={console};sandbox.window=sandbox;"
        f"sandbox.CD_PARKING_DEMO_NOW={json.dumps(override)};"
        "vm.createContext(sandbox);vm.runInContext(src,sandbox);"
        "process.stdout.write(String(sandbox.CD_PARKING.demoNow));"
    )
    proc = subprocess.run([NODE, "-e", script], capture_output=True, text=True, encoding="utf-8")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == override, f"CD_PARKING_DEMO_NOW 覆盖未生效：demoNow() 返回 {proc.stdout!r}"


def test_demo_now_falls_back_to_default_without_override() -> None:
    """不设覆盖时，demoNow() 必须回落到固定的 DEMO_NOW。"""
    script = (
        "const fs=require('node:fs'),vm=require('node:vm');"
        f"const src=fs.readFileSync({json.dumps(str(RUNTIME))},'utf8');"
        "const sandbox={console};sandbox.window=sandbox;"
        "vm.createContext(sandbox);vm.runInContext(src,sandbox);"
        "process.stdout.write(String(sandbox.CD_PARKING.demoNow));"
    )
    proc = subprocess.run([NODE, "-e", script], capture_output=True, text=True, encoding="utf-8")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == "2026-04-10T14:00:00+08:00", proc.stdout


def test_adapter_template_has_no_stale_known_issue_note() -> None:
    """问题修好了，模板头里那段「已知遗留问题」的说明就该删掉。"""
    adapter = ADAPTER.read_text(encoding="utf-8")
    assert "已知遗留问题" not in adapter
    assert "疑似漏了反斜杠" not in adapter


# --------------------------------------------------------------------------- #
# 缺陷二：生成物行尾策略（生成物一律 LF 落盘）
# --------------------------------------------------------------------------- #


def test_python_writers_emit_lf(tmp_path: Path) -> None:
    """pf.export / pf.synth 的写出必须以 LF 落盘——这是行尾策略的源头。"""
    sys.path.insert(0, str(PF_DIR / "src"))
    from pf.export import write_json, write_text  # noqa: PLC0415
    from pf.synth import _write_json, _write_jsonl  # noqa: PLC0415

    write_json(tmp_path / "a.json", {"k": "v", "n": [1, 2]})
    write_text(tmp_path / "a.md", "line1\nline2\n")
    _write_json(tmp_path / "b.json", {"k": "v"})
    _write_jsonl(tmp_path / "c.jsonl", [{"a": 1}, {"a": 2}])

    for name in ("a.json", "a.md", "b.json", "c.jsonl"):
        data = (tmp_path / name).read_bytes()
        assert b"\r\n" not in data, f"{name} 含 CRLF：生成物必须一律 LF 落盘"


def test_exported_products_use_lf(tmp_path: Path) -> None:
    """导出器产出的两个产物必须是 LF（--out-dir 落到临时目录，不污染工作区）。"""
    proc = _run("--out-dir", str(tmp_path))
    assert proc.returncode == 0, proc.stderr
    for name in ("parking-artifact.js", "parking-runtime.js"):
        data = (tmp_path / name).read_bytes()
        assert b"\r\n" not in data, f"{name} 含 CRLF"
        assert data.endswith(b"\n")


def test_manifest_files_hash_matches_model_json_bytes() -> None:
    """artifacts/manifest.json 的 files 记录 == model.json 的字节哈希（LF 归一化后）。

    生成物一律 LF 落盘，故「记录值 = LF 字节哈希 = Git blob 哈希」三者相等；
    CRLF 检出环境下磁盘字节是 CRLF，此时用 LF 归一化后的字节比对。
    """
    manifest = json.loads((PF_DIR / "artifacts" / "manifest.json").read_text(encoding="utf-8"))
    raw = (PF_DIR / "artifacts" / "model.json").read_bytes()
    lf = raw.replace(b"\r\n", b"\n")
    want = manifest["files"]["model.json"]
    assert want == _sha256_bytes(lf), "manifest 记录的 model.json 哈希与文件字节不一致"
    if b"\r\n" not in raw:
        assert want == _sha256_bytes(raw), "LF 工作区里记录值应等于原始字节哈希"
    metrics = json.loads((PF_DIR / "artifacts" / "metrics.json").read_text(encoding="utf-8"))
    assert metrics["source"] == "synthetic"


def test_synthetic_manifest_file_sha256_matches_jsonl_bytes() -> None:
    """data/synthetic/manifest.json 的 file_sha256 == 三份 jsonl 的字节哈希。"""
    manifest = json.loads((PF_DIR / "data" / "synthetic" / "manifest.json").read_text(encoding="utf-8"))
    for name in ("lots.jsonl", "observations.jsonl", "signals.jsonl"):
        raw = (PF_DIR / "data" / "synthetic" / name).read_bytes()
        lf = raw.replace(b"\r\n", b"\n")
        want = manifest["file_sha256"][name]
        assert want == _sha256_bytes(lf), f"{name} 的记录哈希与文件字节不一致"
        if b"\r\n" not in raw:
            assert want == _sha256_bytes(raw), f"{name} 的记录值应等于原始字节哈希"


def test_data_fingerprint_derives_from_synthetic_manifest() -> None:
    """model.json 的 data_fingerprint 由 manifest 的三个哈希按顺序拼成。"""
    model = json.loads((PF_DIR / "artifacts" / "model.json").read_text(encoding="utf-8"))
    manifest = json.loads((PF_DIR / "data" / "synthetic" / "manifest.json").read_text(encoding="utf-8"))
    derived = ":".join(
        manifest["file_sha256"][n] for n in ("lots.jsonl", "observations.jsonl", "signals.jsonl")
    )
    assert model["data_fingerprint"] == derived
