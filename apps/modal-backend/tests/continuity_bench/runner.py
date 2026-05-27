"""Continuity-bench runner: load session → score → report.

CLI usage::

    cd apps/modal-backend
    .venv/bin/python -m tests.continuity_bench.runner \
        --session tests/continuity_bench/fixtures/example_session/manifest.json \
        --out tests/continuity_bench/reports/latest.json

The judge VLM is whatever OPENROUTER_VLM_MODEL points to (override via
CONTINUITY_BENCH_JUDGE_MODEL).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ._replay import PageRecord, SessionRecord, load_session
from ._score import score_entity_consistency, score_prompt_alignment, score_style_pair

_BENCH_VERSION = 1


@dataclass
class PairwiseScore:
    from_page_id: str
    to_page_id: str
    score: float
    rationale: str


@dataclass
class EntityScore:
    entity_id: str
    entity_name: str
    pair_scores: list[PairwiseScore] = field(default_factory=list)
    mean_score: float = 0.0


@dataclass
class PageScore:
    page_id: str
    prompt_alignment: float
    rationale: str


@dataclass
class ContinuityReport:
    bench_version: int
    judge_model: str
    session_id: str
    started_at: str
    style_drift_pairs: list[PairwiseScore]
    style_drift_mean: float
    entity_scores: list[EntityScore]
    page_alignment_scores: list[PageScore]
    summary: dict[str, Any]


def _load_image(page: PageRecord) -> bytes:
    return page.image_path.read_bytes()


async def _score_style_drift(session: SessionRecord) -> list[PairwiseScore]:
    out: list[PairwiseScore] = []
    if len(session.pages) < 2:
        return out
    for prev, cur in zip(session.pages, session.pages[1:], strict=False):
        result = await score_style_pair(_load_image(prev), _load_image(cur))
        out.append(
            PairwiseScore(
                from_page_id=prev.page_id,
                to_page_id=cur.page_id,
                score=result.score,
                rationale=result.rationale,
            )
        )
    return out


def _collect_entity_appearances(
    session: SessionRecord,
) -> dict[str, list[PageRecord]]:
    out: dict[str, list[PageRecord]] = {}
    for page in session.pages:
        for entity in page.entities:
            out.setdefault(entity.entity_id, []).append(page)
    return out


async def _score_entity_consistency(
    session: SessionRecord,
) -> list[EntityScore]:
    appearances = _collect_entity_appearances(session)
    out: list[EntityScore] = []
    for entity_id, pages in appearances.items():
        if len(pages) < 2:
            continue
        canonical = next(
            (e for p in pages for e in p.entities if e.entity_id == entity_id),
            None,
        )
        if canonical is None:
            continue

        pair_scores: list[PairwiseScore] = []
        first = pages[0]
        for later in pages[1:]:
            result = await score_entity_consistency(
                canonical.name, canonical.appearance, _load_image(first), _load_image(later)
            )
            pair_scores.append(
                PairwiseScore(
                    from_page_id=first.page_id,
                    to_page_id=later.page_id,
                    score=result.score,
                    rationale=result.rationale,
                )
            )
        mean_score = (
            round(statistics.mean(p.score for p in pair_scores), 4)
            if pair_scores
            else 0.0
        )
        out.append(
            EntityScore(
                entity_id=entity_id,
                entity_name=canonical.name,
                pair_scores=pair_scores,
                mean_score=mean_score,
            )
        )
    return out


async def _score_prompt_alignment(session: SessionRecord) -> list[PageScore]:
    out: list[PageScore] = []
    for page in session.pages:
        result = await score_prompt_alignment(page.prompt, _load_image(page))
        out.append(
            PageScore(
                page_id=page.page_id,
                prompt_alignment=result.score,
                rationale=result.rationale,
            )
        )
    return out


def _summarize(report_parts: dict[str, Any]) -> dict[str, Any]:
    style_scores = [p.score for p in report_parts["style_drift_pairs"]]
    entity_means = [e.mean_score for e in report_parts["entity_scores"]]
    page_scores = [p.prompt_alignment for p in report_parts["page_alignment_scores"]]

    return {
        "n_pages": report_parts["n_pages"],
        "n_style_pairs": len(style_scores),
        "style_drift_mean": (
            round(statistics.mean(style_scores), 4) if style_scores else 0.0
        ),
        "style_drift_min": min(style_scores) if style_scores else 0.0,
        "n_entities_tracked": len(entity_means),
        "entity_consistency_mean": (
            round(statistics.mean(entity_means), 4) if entity_means else 0.0
        ),
        "entity_consistency_min": min(entity_means) if entity_means else 0.0,
        "prompt_alignment_mean": (
            round(statistics.mean(page_scores), 4) if page_scores else 0.0
        ),
        "prompt_alignment_min": min(page_scores) if page_scores else 0.0,
    }


async def run_bench(
    session_manifest: Path,
    *,
    out_path: Path | None = None,
) -> ContinuityReport:
    session = load_session(session_manifest)

    style_drift = await _score_style_drift(session)
    entity_scores = await _score_entity_consistency(session)
    page_alignment = await _score_prompt_alignment(session)

    summary = _summarize(
        {
            "n_pages": len(session.pages),
            "style_drift_pairs": style_drift,
            "entity_scores": entity_scores,
            "page_alignment_scores": page_alignment,
        }
    )

    from ._score import _judge_model

    report = ContinuityReport(
        bench_version=_BENCH_VERSION,
        judge_model=_judge_model(),
        session_id=session.session_id,
        started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        style_drift_pairs=style_drift,
        style_drift_mean=summary["style_drift_mean"],
        entity_scores=entity_scores,
        page_alignment_scores=page_alignment,
        summary=summary,
    )

    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(
                {
                    "bench_version": report.bench_version,
                    "judge_model": report.judge_model,
                    "session_id": report.session_id,
                    "started_at": report.started_at,
                    "style_drift_pairs": [asdict(p) for p in report.style_drift_pairs],
                    "entity_scores": [asdict(e) for e in report.entity_scores],
                    "page_alignment_scores": [
                        asdict(p) for p in report.page_alignment_scores
                    ],
                    "summary": report.summary,
                },
                indent=2,
            )
        )

    return report


def _cli() -> None:
    parser = argparse.ArgumentParser(description="continuity bench (ViStoryBench-lite)")
    parser.add_argument("--session", type=Path, required=True, help="path to manifest.json")
    parser.add_argument("--out", type=Path, default=None, help="optional report path")
    args = parser.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("OPENROUTER_API_KEY is required to run the bench.")

    report = asyncio.run(run_bench(args.session, out_path=args.out))
    print(
        json.dumps(
            {
                "judge_model": report.judge_model,
                "session_id": report.session_id,
                "summary": report.summary,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    _cli()
