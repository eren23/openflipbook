"""Walk judges and the walk bench — FREE, no network.

The spec-conformance scorer is pinned on its prompt (every label, the order,
every ground side) and on a recorded reply fixture. The snap metric runs on
synthetic bytes and, when ffmpeg is here, on a real clip with one hard cut.
The bench builds a report from a fake run dir under MOCK_PROVIDERS (mock
judges, $0) with the downloads stubbed. The one `paid` test self-skips.
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from providers import judge
from providers.judge import JudgeResult
from tests.matrix_bench._budget import Ledger
from tests.matrix_bench._cache import CellCache, JudgeCache
from tests.walk_bench import runner

_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "vlm_replies"
_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
needs_ffmpeg = pytest.mark.skipif(not _FFMPEG, reason="ffmpeg/ffprobe not installed")

SPEC: dict[str, Any] = {
    "objects": [
        {"label": "Bellfounder Hall", "visual": "bronze-roofed hall", "h_pos": "far-left",
         "v_pos": "middle", "size": "large", "distance": 12.4, "share": 0.2},
        {"label": "Lantern Lighthouse", "h_pos": "center-right", "v_pos": "upper",
         "size": "small", "distance": 40, "share": 0.05},
    ],
    "ground": [{"label": "River Lantern", "side": "right", "visual": "slow green river"}],
}


def _capture(monkeypatch: pytest.MonkeyPatch, raw: str) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    async def fake_ask(system: str, user_text: str, blocks: list[dict[str, object]]) -> JudgeResult:
        seen.update(system=system, user_text=user_text, blocks=blocks)
        return judge._parse_judgement(raw)

    monkeypatch.setattr(judge, "_ask_judge", fake_ask)
    return seen


async def test_spec_prompt_names_every_object_in_order_and_parses_the_fixture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _capture(monkeypatch, (_FIXTURES / "spec_conformance_gemini_fenced.txt").read_text())

    result = await judge.score_spec_conformance(b"FRAME", SPEC)

    text = seen["user_text"]
    assert text.index("Bellfounder Hall") < text.index("Lantern Lighthouse")
    assert "far-left" in text and "center-right" in text and "bronze-roofed hall" in text
    assert "River Lantern on the right" in text
    assert "no other named landmark" in seen["system"].lower()
    assert len(seen["blocks"]) == 1
    assert result.score == 6.0
    assert result.rationale.startswith(
        "missed: Lantern Lighthouse; invented: domed clock tower; Bellfounder Hall"
    )


async def test_spec_empty_spec_and_bad_replies(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _capture(monkeypatch, '{"score": 9, "missed": [], "invented": [], "rationale": "ok"}')
    result = await judge.score_spec_conformance(b"FRAME", {"objects": None})
    assert "(none: the view must show no named landmark)" in seen["user_text"]
    assert (result.score, result.rationale) == (9.0, "ok")

    # Cut by max_tokens: the score and the missed list still come through.
    _capture(monkeypatch, '{"score": 3, "missed": ["Bellfounder Hall", "Lantern Lighthouse"], "inv')
    result = await judge.score_spec_conformance(b"FRAME", SPEC)
    assert result.score == 3.0
    assert result.rationale.startswith("missed: Bellfounder Hall, Lantern Lighthouse; ")

    # No score at all stays the loud UNPARSEABLE 0, untouched.
    _capture(monkeypatch, "I cannot see the image.")
    result = await judge.score_spec_conformance(b"FRAME", SPEC)
    assert result.score == 0.0 and result.rationale.startswith(judge._UNPARSEABLE_PREFIX)


async def test_median_of_keeps_the_middle_verdict() -> None:
    scores = iter([9.0, 2.0, 5.0, 4.0])
    calls = 0

    async def one() -> JudgeResult:
        nonlocal calls
        calls += 1
        return JudgeResult(next(scores), "r", "")

    assert (await judge.median_of(3, one)).score == 5.0
    assert (await judge.median_of(0, one)).score == 4.0  # n below 1 still asks once
    assert calls == 4


def test_deltas_and_snap_stats_on_synthetic_frames() -> None:
    n = 4 * 2
    raw = bytes(n) * 3 + bytes([255]) * n + b"\x01"  # a trailing partial frame is dropped
    d = runner.deltas(raw, 4, 2)
    assert d == [0.0, 0.0, 255.0]
    stats = runner.snap_stats(d)
    assert stats == {"frames": 4, "median": 0.0, "max": 255.0, "max_at": 0.667, "ratio": 25500.0}
    assert runner.snap_stats([]) == {"frames": 0}


# 25 fps: audit_frames takes the last frame at duration - 0.06 s.
def _clip(path: Path, first: str = "black", second: str = "white") -> bytes:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "lavfi", "-i", f"color=c={first}:s=128x72:r=25:d=1",
         "-f", "lavfi", "-i", f"color=c={second}:s=128x72:r=25:d=1",
         "-filter_complex", "[0][1]concat=n=2:v=1", "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )
    return path.read_bytes()


@needs_ffmpeg
def test_snap_metric_finds_the_hard_cut_in_a_real_clip(tmp_path: Path) -> None:
    _clip(tmp_path / "cut.mp4")
    stats = runner.snap_stats(runner.deltas(runner.gray_frames(tmp_path / "cut.mp4")))
    assert stats["frames"] == 50
    assert stats["median"] < 1 and stats["max"] > 200
    assert 0.4 < stats["max_at"] < 0.6


def test_snap_points_prefer_v2_snaps_and_fall_back_to_leg_ends() -> None:
    request = {"shots": [{"index": 0, **SPEC}, {"index": 1}, {"index": 2}]}
    v1 = {"keyframes": ["data:0", "data:1", "data:2"],
          "clips": [{"from_shot": 0, "to_shot": 1}, {"from_shot": 1, "to_shot": 2}]}
    points = runner.snap_points(request, v1)
    assert [(p["index"], p["image_url"]) for p in points] == [(0, "data:0"), (1, None), (2, None)]
    assert points[0]["spec"]["objects"] == SPEC["objects"]
    assert points[1]["spec"] == {"objects": [], "ground": [], "move": None}

    v2 = v1 | {"snaps": [{"index": 1, "image_url": "https://x/1.jpg", "corrected": True,
                          "conformance": 7.5}]}
    (point,) = runner.snap_points(request, v2)
    assert (point["index"], point["corrected"], point["conformance"]) == (1, True, 7.5)


def _png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (200, 120), "tan").save(buf, format="PNG")
    return buf.getvalue()


def _run_dir(root: Path, *, clips: bool) -> Path:
    run = root / "quay-run"
    run.mkdir()
    shots = [{"index": i, **SPEC} for i in range(3)]
    data = "data:image/png;base64," + base64.b64encode(_png()).decode()
    response: dict[str, Any] = {"keyframes": [data] * 3, "spent_usd": 1.0}
    if clips:
        response["clips"] = [
            {"from_shot": 0, "to_shot": 1, "video_url": "https://fal/leg0.mp4", "model": "m"},
            {"from_shot": 1, "to_shot": 2, "video_url": "https://fal/leg1.mp4", "model": "m"},
        ]
        response["video_url"] = "https://fal/walk.mp4"
    (run / "request.json").write_text(json.dumps({"session_id": "s", "shots": shots}))
    (run / "response.json").write_text(json.dumps(response))
    (run / "map.png").write_bytes(_png())
    (run / "route.json").write_text(json.dumps({
        "frame": {"x": 0, "y": 0, "w": 100, "h": 60},
        "points": [{"x": 10, "y": 10}, {"x": 50, "y": 30}],
        "checkpoints": [{"x": 10, "y": 10, "gaze": 0.5}, {"x": 50, "y": 30, "gaze": 1.0}],
    }))
    return run


@needs_ffmpeg
async def test_build_writes_the_report_and_review_then_rebills_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")  # mock judges: every score is 8.5
    clips = {"leg0": _clip(tmp_path / "a.mp4", "gray", "silver"), "leg1": _clip(tmp_path / "b.mp4")}
    downloads: list[str] = []

    def download(url: str) -> bytes:
        downloads.append(url)
        return clips.get(url.split("/")[-1][:-4], clips["leg0"])

    monkeypatch.setattr(runner, "_download", download)
    run, out = _run_dir(tmp_path, clips=True), tmp_path / "out"
    cache = CellCache(tmp_path / "cache")

    report = await runner.build(
        run, out, ledger=Ledger(cap_usd=1.0), cache=cache, jcache=JudgeCache(cache.root)
    )

    assert [s["index"] for s in report["snaps"]] == [0, 1, 2]
    assert all(s["spec_score"]["score"] == 8.5 for s in report["snaps"])
    assert all(s["style_score"]["score"] == 8.5 for s in report["snaps"])
    # the first stop is judged against the map's medium, later ones for drift
    assert [s["style_ref"] for s in report["snaps"]] == ["map", "first stop", "first stop"]
    # Both labels sit at 3 snap points: one first-vs-last identity call each.
    assert [(e["label"], e["from"], e["to"]) for e in report["entities"]] == [
        ("Bellfounder Hall", 0, 2), ("Lantern Lighthouse", 0, 2)
    ]
    assert report["spent_usd"] == pytest.approx(3 * 4 * 0.005 + 2 * 0.005)
    assert report["legs"][0]["snap"]["max"] > report["legs"][0]["snap"]["median"]
    assert report["summary"]["spec_min"] == 8.5 and report["merged"]["snap"]["frames"] == 50
    assert (out / "snap-1.jpg").read_bytes() == (out / "leg-0-1-frame-4.jpg").read_bytes()
    page = (out / "review.html").read_text()
    assert "<svg" in page and "<polyline" in page and 'src="walk.mp4"' in page
    assert "Bellfounder Hall" in page and "River Lantern on the right" in page
    assert json.loads((out / "report.json").read_text())["summary"] == report["summary"]
    assert sorted(downloads) == ["https://fal/leg0.mp4", "https://fal/leg1.mp4", "https://fal/walk.mp4"]

    again = await runner.build(
        run, tmp_path / "out2", ledger=Ledger(cap_usd=1.0), cache=cache,
        jcache=JudgeCache(cache.root),
    )
    assert again["spent_usd"] == 0.0 and all(s["spec_score"]["cached"] for s in again["snaps"])
    assert len(downloads) == 3  # media came from the cache


async def test_budget_stops_before_the_first_paid_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def never(*_a: object) -> JudgeResult:
        raise AssertionError("a judge ran past the cap")

    monkeypatch.setattr(judge, "_ask_judge", never)
    cache = CellCache(tmp_path / "cache")
    report = await runner.build(
        _run_dir(tmp_path, clips=False), tmp_path / "out", ledger=Ledger(cap_usd=0.01),
        cache=cache, jcache=JudgeCache(cache.root),
    )
    assert "cap" in report["stopped_reason"] and report["spent_usd"] == 0.0
    assert "spec_score" not in report["snaps"][0]
    assert "Stopped:" in (tmp_path / "out" / "review.html").read_text()


async def test_a_failed_verdict_is_not_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _capture(monkeypatch, "no json here")
    cache = CellCache(tmp_path / "cache")
    report = await runner.build(
        _run_dir(tmp_path, clips=False), tmp_path / "out", ledger=Ledger(cap_usd=1.0),
        cache=cache, jcache=JudgeCache(cache.root),
    )
    assert report["summary"]["spec_min"] == 0.0
    assert not (cache.root / "judges").exists()


def test_dry_run_prints_the_plan_and_touches_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("WALK_BENCH_RUN", raising=False)
    monkeypatch.setattr(runner, "_download", lambda url: pytest.fail("dry run fetched"))
    run = _run_dir(tmp_path, clips=True)
    assert runner.main([str(run)]) == 0
    plan = json.loads(capsys.readouterr().out.split("\nDry run")[0])
    # 3 snaps x (3 spec + 1 style) + 2 identity calls
    assert plan == {"run": "quay-run", "snaps": 3, "legs": 2, "merged_video": True,
                    "judge_calls_max": 14, "estimate_usd_max": 0.07}
    assert not (run / "report.json").exists()


@pytest.mark.paid
def test_walk_bench_live() -> None:
    """The real bench on a saved run: WALK_BENCH_RUN=1 WALK_BENCH_DIR=<dir>."""
    if os.environ.get("WALK_BENCH_RUN") != "1" or not os.environ.get("WALK_BENCH_DIR"):
        pytest.skip("set WALK_BENCH_RUN=1 and WALK_BENCH_DIR=<run dir> to judge a saved walk")
    assert runner.main([os.environ["WALK_BENCH_DIR"]]) == 0
