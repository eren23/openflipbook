"""P3 generate-wiring gate (free): the layout clause appears only when the
geometry-gen flag is on AND an expected layout was sent (flag-off = no change)."""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest

# generate.py imports `modal` at module level (deploy-only, not a test dep).
sys.modules.setdefault("modal", MagicMock())

import generate  # noqa: E402
from generate import GenerateBody, ProjectedEntity  # noqa: E402


def _proj(label: str) -> ProjectedEntity:
    return ProjectedEntity(
        id="a",
        label=label,
        x_pct=0.5,
        y_pct=0.3,
        w_pct=0.2,
        h_pct=0.5,
        depth=10.0,
        h_pos="center",
        v_pos="top",
        size="large",
    )


def _body(expected: list[ProjectedEntity]) -> GenerateBody:
    return GenerateBody(query="q", session_id="s", expected_layout=expected)


def test_layout_clause_off_when_flag_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORLD_GEOMETRY_GEN", raising=False)
    assert generate._layout_clause_for(_body([_proj("Tower")])) == ""


def test_layout_clause_on_with_flag_and_expected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORLD_GEOMETRY_GEN", "true")
    clause = generate._layout_clause_for(_body([_proj("Tower")]))
    assert "SCENE LAYOUT" in clause
    assert "Tower — large, center top" in clause


def test_layout_clause_empty_without_expected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORLD_GEOMETRY_GEN", "true")
    assert generate._layout_clause_for(_body([])) == ""
