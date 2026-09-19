"""Wire and ledger shapes for the decision layer.

A decision is one typed question set put to a probability model over TEXT
the pipeline already holds -- reviewer scores and rationales, the click
classifier's reading, budget numbers. The model returns probabilities only:
never text, never an option it was not given.
"""
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

Mode = Literal["off", "shadow", "advise", "live"]
Outcome = Literal["good", "bad", "false_positive"]


class NoulQ(TypedDict, total=False):
    type: Literal["noul"]
    instructions: str
    criteria: dict[str, str]  # {"true": ..., "false": ...}


class ChoiceQ(TypedDict):
    type: Literal["choice"]
    instructions: str
    criteria: dict[str, str]  # option -> description, 2..255 of them


class ScoreQ(TypedDict):
    type: Literal["score"]
    instructions: str
    criteria: list[str]  # ordered levels, "name: description"


Question = NoulQ | ChoiceQ | ScoreQ


class DecisionReceipt(TypedDict):
    """Mirror of TS ``DecisionReceipt``: what rides ``final.decisions[]``.

    Small enough to persist beside ``view_verdict``; never the state."""

    id: str
    site: str
    mode: str
    verdict: dict[str, str | None]
    incumbent: dict[str, str | None]
    agree: bool | None
    p: dict[str, float]
    applied: bool
    latency_ms: int
    cost_usd: float
    error: str | None


class DecisionRow(DecisionReceipt):
    """The ledger row: the receipt plus everything a report needs to replay
    or re-judge the decision. Lives on the log line."""

    ts: str
    trace_id: str | None
    session_id: str | None
    backend: str
    model: str
    mock: bool
    state: str | dict[str, Any]
    questions: dict[str, Any]
    answers: dict[str, Any] | None
    usage: dict[str, int] | None
    outcome: NotRequired[Outcome | None]
