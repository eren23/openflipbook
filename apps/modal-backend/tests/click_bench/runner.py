"""Bench runner: load fixtures, call click_to_subject, score, report.

CLI usage::

    cd apps/modal-backend
    .venv/bin/python -m tests.click_bench.runner \
        --fixtures tests/click_bench/fixtures/v1.json \
        --out tests/click_bench/reports/latest.json

Set ``CLICK_BENCH_MODEL=qwen/qwen3-vl-8b-instruct`` (or any OpenRouter VLM)
to A/B against the default ``OPENROUTER_VLM_MODEL``.
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

from . import _annotate, _score

_BENCH_VERSION = 1


@dataclass(frozen=True)
class BenchCase:
    case_id: str
    image_path: str
    x_pct: float
    y_pct: float
    parent_title: str
    parent_query: str
    expected_subject: str
    alternates: list[str] = field(default_factory=list)
    groundable: bool = True
    output_locale: str | None = None
    notes: str = ""


@dataclass
class CaseResult:
    case_id: str
    predicted_subject: str
    predicted_style: str
    predicted_context: str
    expected_subject: str
    score: dict[str, Any]
    latency_ms: float
    ok: bool
    error: str | None = None


@dataclass
class BenchReport:
    bench_version: int
    model: str
    started_at: str
    cases: list[CaseResult]
    summary: dict[str, Any]


def load_fixtures(path: Path) -> list[BenchCase]:
    raw = json.loads(path.read_text())
    cases_raw = raw.get("cases", [])
    return [BenchCase(**case) for case in cases_raw]


async def _run_case(
    case: BenchCase, fixture_dir: Path, *, model_override: str | None
) -> CaseResult:
    from providers import llm

    image_bytes = (fixture_dir / case.image_path).read_bytes()
    annotated = _annotate.annotate_click_point(image_bytes, case.x_pct, case.y_pct)
    data_url = _annotate.to_data_url(annotated)

    if model_override:
        os.environ["OPENROUTER_VLM_MODEL"] = model_override

    started = time.perf_counter()
    try:
        resolution = await llm.click_to_subject(
            image_data_url=data_url,
            x_pct=case.x_pct,
            y_pct=case.y_pct,
            parent_title=case.parent_title,
            parent_query=case.parent_query,
            output_locale=case.output_locale,
        )
    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return CaseResult(
            case_id=case.case_id,
            predicted_subject="",
            predicted_style="",
            predicted_context="",
            expected_subject=case.expected_subject,
            score={},
            latency_ms=latency_ms,
            ok=False,
            error=f"{type(exc).__name__}: {exc}",
        )
    latency_ms = round((time.perf_counter() - started) * 1000, 2)

    score = _score.score_subject(
        resolution.subject, case.expected_subject, case.alternates
    )
    return CaseResult(
        case_id=case.case_id,
        predicted_subject=resolution.subject,
        predicted_style=resolution.style,
        predicted_context=resolution.subject_context,
        expected_subject=case.expected_subject,
        score=asdict(score),
        latency_ms=latency_ms,
        ok=score.passed(),
    )


def _summarize(results: list[CaseResult]) -> dict[str, Any]:
    if not results:
        return {"n": 0}
    completed = [r for r in results if r.error is None]
    composites = [r.score.get("composite", 0.0) for r in completed]
    latencies = [r.latency_ms for r in completed]
    summary: dict[str, Any] = {
        "n": len(results),
        "n_completed": len(completed),
        "n_errored": len(results) - len(completed),
        "n_passed": sum(1 for r in results if r.ok),
        "pass_rate": (
            round(sum(1 for r in results if r.ok) / len(results), 4)
            if results
            else 0.0
        ),
    }
    if composites:
        summary["composite_mean"] = round(statistics.mean(composites), 4)
        summary["composite_median"] = round(statistics.median(composites), 4)
    if latencies:
        summary["latency_p50_ms"] = round(statistics.median(latencies), 2)
        summary["latency_p95_ms"] = round(
            statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 5 else max(latencies),
            2,
        )
        summary["latency_mean_ms"] = round(statistics.mean(latencies), 2)
    return summary


async def run_bench(
    fixtures_path: Path,
    *,
    model_override: str | None = None,
    out_path: Path | None = None,
) -> BenchReport:
    cases = load_fixtures(fixtures_path)
    fixture_dir = fixtures_path.parent

    results: list[CaseResult] = []
    for case in cases:
        result = await _run_case(case, fixture_dir, model_override=model_override)
        results.append(result)

    model = model_override or os.environ.get("OPENROUTER_VLM_MODEL", "default")
    report = BenchReport(
        bench_version=_BENCH_VERSION,
        model=model,
        started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        cases=results,
        summary=_summarize(results),
    )

    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(
                {
                    "bench_version": report.bench_version,
                    "model": report.model,
                    "started_at": report.started_at,
                    "cases": [asdict(c) for c in report.cases],
                    "summary": report.summary,
                },
                indent=2,
            )
        )
    return report


def _cli() -> None:
    parser = argparse.ArgumentParser(description="click resolver micro-bench")
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=Path(__file__).parent / "fixtures" / "v1.json",
        help="path to fixtures JSON",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="write JSON report to this path",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="OpenRouter VLM slug to A/B against the default",
    )
    args = parser.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit(
            "OPENROUTER_API_KEY is required to run the bench against a real VLM."
        )

    report = asyncio.run(
        run_bench(args.fixtures, model_override=args.model, out_path=args.out)
    )

    print(json.dumps({"model": report.model, "summary": report.summary}, indent=2))


if __name__ == "__main__":
    _cli()
