"""Tiny env helpers, shared by generate.py and the providers.

Kept minimal on purpose — only consolidates the boolean-flag parse that was
duplicated across ~11 call sites (`os.environ.get("X", "<default>").lower() in
("1", "true", "yes")`). The per-flag default matters (most default off, but
IMAGE_CONDITIONING / PROGRESSIVE_DRAFT / OPENROUTER_CACHE / etc. default on), so
it stays a parameter — semantics are byte-for-byte the inlined checks.
"""

from __future__ import annotations

import os

_TRUTHY = ("1", "true", "yes")


def env_flag(name: str, default: str = "false") -> bool:
    """True iff env var ``name`` (or ``default`` when unset) is in the truthy
    set. Case-insensitive; anything outside the set ("0", "off", "no", "") is
    False."""
    return os.environ.get(name, default).lower() in _TRUTHY
