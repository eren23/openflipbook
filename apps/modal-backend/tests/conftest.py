"""Shared pytest fixtures and env scrubbing.

Most tests set their own env values; the fixture here just guarantees we
don't leak host config (FAL_KEY, OPENROUTER_API_KEY, etc.) into test runs.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Add repo's modal-backend root to sys.path so `from providers.image import …`
# works without needing a wheel install.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_SCRUB = (
    "FAL_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_VLM_MODEL",
    "OPENROUTER_TEXT_MODEL",
    "OPENROUTER_ENABLE_WEB_SEARCH",
    "OPENROUTER_CACHE",
    # Multi-provider LLM selection (PR1) — scrub so a host-set provider can't
    # make provider/model/tier resolution tests non-hermetic.
    "LLM_PROVIDER",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_VLM_MODEL",
    "LLM_TEXT_MODEL",
    "LLM_STRUCTURED_OUTPUT",
    "FAL_IMAGE_TIER",
    "FAL_IMAGE_MODEL",
    "FAL_IMAGE_MODEL_FAST",
    "FAL_IMAGE_MODEL_BALANCED",
    "FAL_IMAGE_MODEL_PRO",
    # Multi-provider image backend (PR2).
    "IMAGE_PROVIDER",
    "IMAGE_BASE_URL",
    "IMAGE_API_KEY",
    "IMAGE_MODEL",
    "IMAGE_SIZE",
    # World Mode (tap enters a place; gated off by default).
    "WORLD_MODE",
    "FAL_CONTINUE_MODEL",
    # Enter-via-edit (default ON — scrub so a host kill-switch can't silently
    # flip the routing tests) + the edit-tier knobs it can interact with.
    "ENTER_EDIT_REF",
    # View grammar (default ON — same hermeticity reasoning).
    "VIEW_GRAMMAR",
    "FAL_ENTER_MODEL",
    "FAL_EDIT_TIER",
    "FAL_EDIT_MODEL_FAST",
    "FAL_EDIT_MODEL_BALANCED",
    "FAL_EDIT_MODEL_PRO",
    # Geometric world model (numeric map, observer poses, grounded gen).
    "GEOMETRIC_WORLD",
    "WORLD_GEOMETRY_GEN",
    "WORLD_TOPDOWN_MAPS",
    "VLM_GROUNDING",
    "VLM_GROUNDING_REPAIR",
    "FAL_OUTPAINT_MODEL",
    "FAL_INPAINT_MODEL",
    "FAL_UPSCALE_MODEL",
    "FAL_DETECTOR_MODEL",
    # world_bench eval gates — keep host-set run flags / judge pin out of tests.
    "LAYOUT_BENCH_RUN",
    "GROUNDING_BENCH_RUN",
    "REPAIR_BENCH_RUN",
    "EDIT_BENCH_RUN",
    "WORLD_BENCH_JUDGE_MODEL",
    # Map-pan expand (outpaint the world outward).
    "EXPAND_MAP_PAN",
    "FAL_EXPAND_MODEL",
    # B2 scale-ladder nav — the root .env turns these on for local demos; the
    # OUTWARD edit-ref default is ON so scrubbing keeps the routing tests
    # deterministic either way.
    "SCALE_LADDER_NAV",
    "SCALE_OUTWARD",
    "SCALE_OUTWARD_OUTPAINT",
    "SCALE_OUTWARD_EDIT_REF",
    "SCALE_OUTWARD_RERENDER",
    "SCALE_AROUND_LOGICAL",
    "SENTRY_DSN",
)


@pytest.fixture(autouse=True)
def scrub_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in _SCRUB:
        if k in os.environ:
            monkeypatch.delenv(k, raising=False)
