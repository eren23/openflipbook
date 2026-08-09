#!/usr/bin/env python3
"""Cycle check for apps/modal-backend production Python source.

Reproduces the manual DAG audit from docs/cleanup/2026-06-13-rerun/02-circular-deps.md,
mechanized: AST-parses every production module, keeps only MODULE-BODY imports as
hard edges (imports inside functions = lazy/call-time; imports under
`if TYPE_CHECKING:` = erased at runtime — both are non-edges per the standard,
but are collected separately and cycle-checked informationally).
"""
import ast, os, sys
from pathlib import Path

ROOT = Path("/Users/eren/Documents/AI/openflipbook/apps/modal-backend")
SKIP_DIRS = {"__pycache__", "tests", ".pytest_cache", "node_modules", ".venv", "venv"}

def module_name(p: Path) -> str:
    rel = p.relative_to(ROOT).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) if parts else "<root>"

files = {}
for p in sorted(ROOT.rglob("*.py")):
    parts = p.relative_to(ROOT).parts[:-1]
    if any(d in SKIP_DIRS or d.startswith(".") for d in parts):
        continue
    if p.name.startswith("test_") or p.name == "conftest.py":
        continue
    files[module_name(p)] = p

known = set(files)
# a package dir counts as a known target too (providers, providers.llm, ...)
for m in list(known):
    while "." in m:
        m = m.rsplit(".", 1)[0]
        known.add(m)

def resolve(node, cur_mod, cur_is_pkg):
    """Yield intra-repo module names imported by this Import/ImportFrom node."""
    out = []
    if isinstance(node, ast.Import):
        for a in node.names:
            out.append(a.name)
    elif isinstance(node, ast.ImportFrom):
        if node.level == 0:
            base = node.module or ""
        else:
            # relative: strip (level - (1 if pkg else 0)) trailing parts... standard:
            parts = cur_mod.split(".") if cur_mod != "<root>" else []
            if not cur_is_pkg:
                parts = parts[:-1] if parts else []
            drop = node.level - 1
            parts = parts[: len(parts) - drop] if drop else parts
            base = ".".join(parts + ([node.module] if node.module else []))
        if base:
            out.append(base)
            # `from X import Y` where X.Y is a module
            for a in node.names:
                out.append(f"{base}.{a.name}")
        else:
            for a in node.names:
                out.append(a.name)
    hits = set()
    for cand in out:
        m = cand
        while m:
            if m in known:
                hits.add(m)
                break
            m = m.rsplit(".", 1)[0] if "." in m else ""
    return hits

hard, lazy, typeonly = {}, {}, {}
for mod, path in files.items():
    tree = ast.parse(path.read_text(), filename=str(path))
    is_pkg = path.name == "__init__.py"
    h, l, t = set(), set(), set()

    def walk(nodes, bucket):
        for n in nodes:
            if isinstance(n, (ast.Import, ast.ImportFrom)):
                bucket |= resolve(n, mod, is_pkg)
            elif isinstance(n, ast.If):
                cond = ast.dump(n.test)
                b = t if "TYPE_CHECKING" in cond else bucket
                walk(n.body, b); walk(n.orelse, bucket)
            elif isinstance(n, (ast.Try,)):
                walk(n.body, bucket); walk(n.orelse, bucket); walk(n.finalbody, bucket)
                for hnd in n.handlers: walk(hnd.body, bucket)
            elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                # class bodies execute at import time; function bodies do not
                if isinstance(n, ast.ClassDef):
                    walk(n.body, bucket)
                else:
                    walk(n.body, l)
            elif isinstance(n, (ast.With, ast.For, ast.While)):
                walk(n.body, bucket)
                if hasattr(n, "orelse"): walk(n.orelse, bucket)

    walk(tree.body, h)
    hard[mod] = {x for x in h if x != mod}
    lazy[mod] = {x for x in l if x != mod and x not in h}
    typeonly[mod] = {x for x in t if x != mod and x not in h}

def find_cycles(graph):
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {m: WHITE for m in graph}
    stack, cycles = [], []
    def dfs(u):
        color[u] = GRAY; stack.append(u)
        for v in sorted(graph.get(u, ())):
            # edge to a package == edge to its __init__ module if that exists
            tgt = v if v in graph else None
            if tgt is None: continue
            if color.get(tgt) == GRAY:
                cycles.append(stack[stack.index(tgt):] + [tgt])
            elif color.get(tgt) == WHITE:
                dfs(tgt)
        stack.pop(); color[u] = BLACK
    for m in sorted(graph):
        if color[m] == WHITE: dfs(m)
    return cycles

hard_cycles = find_cycles(hard)
merged = {m: hard[m] | lazy[m] for m in hard}
all_cycles = find_cycles(merged)

print(f"production modules scanned: {len(files)}")
print(f"hard (import-time) edges: {sum(len(v) for v in hard.values())}")
print(f"lazy (call-time) edges:   {sum(len(v) for v in lazy.values())}")
print(f"TYPE_CHECKING-only edges: {sum(len(v) for v in typeonly.values())}")
print(f"\nHARD-EDGE CYCLES: {len(hard_cycles)}")
for c in hard_cycles: print("  " + " -> ".join(c))
print(f"HARD+LAZY CYCLES (informational): {len(all_cycles)}")
for c in all_cycles: print("  " + " -> ".join(c))

if "--edges" in sys.argv:
    print("\n-- hard edges --")
    for m in sorted(hard):
        if hard[m]: print(f"{m} -> {sorted(hard[m])}")
sys.exit(1 if hard_cycles else 0)
