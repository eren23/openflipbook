"""Unit tests for the shared env_flag helper (cleanup 5 / DRY)."""

from __future__ import annotations

import pytest

# conftest.py adds the modal-backend root to sys.path, so this resolves _env.py.
from _env import env_flag


@pytest.mark.parametrize("value", ["1", "true", "yes", "TRUE", "Yes", "tRuE"])
def test_truthy_values(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("FLAG_X", value)
    assert env_flag("FLAG_X") is True


@pytest.mark.parametrize("value", ["0", "false", "no", "off", "", "2", "truthy"])
def test_falsy_values(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("FLAG_X", value)
    assert env_flag("FLAG_X") is False


def test_default_false_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FLAG_X", raising=False)
    assert env_flag("FLAG_X") is False


def test_custom_default_true_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # The IMAGE_CONDITIONING / OPENROUTER_CACHE shape: on unless set falsy.
    monkeypatch.delenv("FLAG_X", raising=False)
    assert env_flag("FLAG_X", "true") is True


def test_explicit_set_overrides_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLAG_X", "0")
    assert env_flag("FLAG_X", "true") is False
