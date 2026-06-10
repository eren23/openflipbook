"""Compatibility shim — the VLM judges moved to providers/judge.py.

The render loop needed them in production; the bench keeps importing from
here (incl. the underscore helpers some tests exercise directly).
"""
from __future__ import annotations

from providers.judge import (
    JudgeResult,
    _ask_judge,
    _image_block,
    _judge_model,
    _parse_judgement,
    score_continuation,
    score_entity_consistency,
    score_feature_articulation,
    score_prompt_alignment,
    score_style_pair,
    score_view_conformance,
)

__all__ = [
    "JudgeResult",
    "_ask_judge",
    "_image_block",
    "_judge_model",
    "_parse_judgement",
    "score_continuation",
    "score_entity_consistency",
    "score_feature_articulation",
    "score_prompt_alignment",
    "score_style_pair",
    "score_view_conformance",
]
