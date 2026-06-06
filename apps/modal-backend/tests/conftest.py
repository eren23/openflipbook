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
    "SENTRY_DSN",
)


@pytest.fixture(autouse=True)
def scrub_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in _SCRUB:
        if k in os.environ:
            monkeypatch.delenv(k, raising=False)
