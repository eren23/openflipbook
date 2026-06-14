"""Disk cache for matrix cells and judge replies — evolution's free lunch.

A cell's identity is the sha of everything that could change its output:
(scenario, description sha, arm, model, prompt sha, params sha). Editing a
prompt file or a corpus description changes its sha → only those cells
re-bill; an identical re-run is 100% hits and $0.00 to-bill.

Layout (gitignored):
    tests/matrix_bench/cache/<cell_key>/record.json
    tests/matrix_bench/cache/<cell_key>/image.jpg
    tests/matrix_bench/cache/judges/<judge_key>.json
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

DEFAULT_ROOT = Path(__file__).resolve().parent / "cache"


def _sha(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def params_sha(params: dict[str, Any]) -> str:
    """Order-insensitive digest of the params dict."""
    return _sha(
        json.dumps(params, sort_keys=True, separators=(",", ":")).encode()
    )[:12]


def text_sha(text: str) -> str:
    """Digest for prompt templates / descriptions (full content, not name)."""
    return _sha(text.encode())[:12]


def image_sha(jpeg: bytes) -> str:
    return _sha(jpeg)[:12]


def cell_key(
    scenario_id: str,
    desc_sha: str,
    arm: str,
    model: str,
    prompt_sha: str,
    params: dict[str, Any],
) -> str:
    blob = "|".join(
        [scenario_id, desc_sha, arm, model, prompt_sha, params_sha(params)]
    )
    return _sha(blob.encode())[:20]


def judge_key(judge_name: str, judge_model: str, img_sha: str, extra: str = "") -> str:
    return _sha("|".join([judge_name, judge_model, img_sha, extra]).encode())[:20]


class CellCache:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or DEFAULT_ROOT

    def _dir(self, key: str) -> Path:
        return self.root / key

    def image_path(self, key: str) -> Path:
        return self._dir(key) / "image.jpg"

    def artifact_path(self, key: str, name: str) -> Path:
        """Path to a side artifact (e.g. source.jpg, poster.jpg) inside a cell
        dir. `name` is taken as a basename only — no path traversal."""
        return self._dir(key) / Path(name).name

    def load(self, key: str) -> dict[str, Any] | None:
        p = self._dir(key) / "record.json"
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            return None  # corrupt entry = miss; the cell simply re-runs

    def store(
        self,
        key: str,
        record: dict[str, Any],
        jpeg: bytes | None = None,
        artifacts: dict[str, bytes] | None = None,
    ) -> Path:
        d = self._dir(key)
        d.mkdir(parents=True, exist_ok=True)
        if jpeg is not None:
            (d / "image.jpg").write_bytes(jpeg)
        for name, blob in (artifacts or {}).items():
            # basename only — never let a gen_fn write outside the cell dir
            (d / Path(name).name).write_bytes(blob)
        (d / "record.json").write_text(json.dumps(record, indent=1))
        return d


class JudgeCache:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or DEFAULT_ROOT) / "judges"

    def load(self, key: str) -> dict[str, Any] | None:
        p = self.root / f"{key}.json"
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            return None

    def store(self, key: str, reply: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / f"{key}.json").write_text(json.dumps(reply, indent=1))
