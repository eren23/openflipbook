"""Walk bench: judge one saved walk run. $0 and no network unless WALK_BENCH_RUN=1.

A run directory holds what one live walk sent and got back:
    request.json   the WalkBody sent to POST /walk (shots with objects/ground/move)
    response.json  the Walk returned (keyframes, clips, and snaps/video_url on v2)
    map.png        the town map page (the style reference)
    route.json     optional: {frame:{x,y,w,h}, points:[{x,y}], checkpoints:[{x,y,gaze}]}

Per snap point it scores the frame against that shot's spec (median of 3) and
its style against the map. A landmark that the specs put at two snap points
gets an identity score. Per leg and for the merged video it measures snaps with
no model: frame-to-frame mean abs difference on 64x36 gray frames. A snap is
one delta far above the clip's median. ffmpeg is bench-only (not in the image).

Dry run:  python -m tests.walk_bench.runner <run_dir>     (make eval-walk-dry RUN=<dir>)
Paid:     WALK_BENCH_RUN=1 python -m tests.walk_bench.runner <run_dir>  (make eval-walk)
The judges stop at WALK_BENCH_BUDGET_USD (default $0.50). Output goes to
tests/walk_bench/reports/<run name>/report.json + review.html.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import html
import itertools
import json
import math
import os
import shutil
import statistics
import subprocess
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from providers import judge
from tests.matrix_bench._budget import JUDGE_CALL_FLAT, BudgetExceeded, Ledger
from tests.matrix_bench._cache import (
    CellCache,
    JudgeCache,
    image_sha,
    judge_key,
    params_sha,
    text_sha,
)
from tests.video_transition_bench.runner import audit_frames

_HERE = Path(__file__).resolve().parent
GRAY_W, GRAY_H = 64, 36
SPEC_SAMPLES = 3  # the same median of 3 as TAP_ZOOM_MAP_SAMPLES
CALLS_PER_SNAP = SPEC_SAMPLES + 1  # + the style pair


def deltas(raw: bytes, w: int = GRAY_W, h: int = GRAY_H) -> list[float]:
    """Mean abs difference between each pair of neighbour gray frames."""
    n = w * h
    frames = [raw[i : i + n] for i in range(0, len(raw) - n + 1, n)]
    return [
        sum(abs(a - b) for a, b in zip(f, g, strict=True)) / n
        for f, g in itertools.pairwise(frames)
    ]


def snap_stats(d: list[float]) -> dict[str, Any]:
    """Median, max, where the max is (0-1 of the clip) and max/median."""
    if not d:
        return {"frames": 0}
    med, mx = statistics.median(d), max(d)
    return {
        "frames": len(d) + 1,
        "median": round(med, 3),
        "max": round(mx, 3),
        "max_at": round(d.index(mx) / len(d), 3),
        "ratio": round(mx / max(med, 0.01), 2),
    }


def gray_frames(video: Path) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-vf",
         f"scale={GRAY_W}:{GRAY_H},format=gray", "-f", "rawvideo", "-"],
        capture_output=True,
        check=True,
    ).stdout


def _download(url: str) -> bytes:
    import httpx

    response = httpx.get(url, timeout=120, follow_redirects=True)
    response.raise_for_status()
    return response.content


def fetch(url: str, cache: CellCache) -> bytes:
    """Bytes of a data URL, or of a remote file (downloaded once, then cached)."""
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    # ponytail: keyed by URL, not content — fal storage URLs do not change.
    key = text_sha(url)
    path = cache.artifact_path(key, "media")
    if not path.exists():
        cache.store(key, {"url": url}, artifacts={"media": _download(url)})
    return path.read_bytes()


def _spec(shot: dict[str, Any]) -> dict[str, Any]:
    return {k: shot.get(k) or [] for k in ("objects", "ground")} | {"move": shot.get("move")}


def snap_points(request: dict[str, Any], response: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per snap point: the shot index, its spec, and where its frame is.

    v2 responses list `snaps`. For older ones a snap point is the last frame of
    the leg that ends there (`image_url` None), or keyframe 0 for the start.
    """
    shots = request.get("shots") or []
    by_index = {s.get("index", p): s for p, s in enumerate(shots)}
    if response.get("snaps"):
        return [
            {
                "index": s["index"],
                "image_url": s.get("image_url"),
                "corrected": s.get("corrected"),
                "conformance": s.get("conformance"),
                "spec": _spec(by_index.get(s["index"], {})),
            }
            for s in response["snaps"]
        ]
    ends = {c["to_shot"] for c in response.get("clips") or []}
    keyframes = response.get("keyframes") or []
    points = []
    for p, shot in enumerate(shots):
        index = shot.get("index", p)
        if index in ends:
            url = None
        elif p < len(keyframes):
            url = keyframes[p]
        else:
            continue
        points.append({"index": index, "image_url": url, "spec": _spec(shot)})
    return points


def entity_pairs(snaps: list[dict[str, Any]]) -> list[tuple[str, str, dict[str, Any], dict[str, Any]]]:
    """(label, visual, first snap, last snap) for each object seen at 2+ snap points."""
    seen: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for snap in snaps:
        for obj in snap["spec"]["objects"]:
            if obj.get("label"):
                seen.setdefault(obj["label"], []).append((snap, obj))
    # ponytail: first vs last sighting only (one call per label); add the
    # neighbour pairs if drift inside a walk needs to be located.
    return [
        (label, str(hits[0][1].get("visual") or ""), hits[0][0], hits[-1][0])
        for label, hits in seen.items()
        if len(hits) >= 2
    ]


def plan(run_dir: Path) -> dict[str, Any]:
    """What a paid run would judge, and its top cost. Reads JSON only."""
    request = json.loads((run_dir / "request.json").read_text())
    response = json.loads((run_dir / "response.json").read_text())
    snaps = snap_points(request, response)
    calls = len(snaps) * CALLS_PER_SNAP + len(entity_pairs(snaps))
    return {
        "run": run_dir.name,
        "snaps": len(snaps),
        "legs": len(response.get("clips") or []),
        "merged_video": bool(response.get("video_url")),
        "judge_calls_max": calls,
        "estimate_usd_max": round(calls * JUDGE_CALL_FLAT, 4),
    }


async def _judged(
    name: str,
    image: bytes,
    extra: str,
    calls: int,
    run: Callable[[], Awaitable[judge.JudgeResult]],
    jcache: JudgeCache,
    ledger: Ledger,
) -> dict[str, Any]:
    """A cached judge verdict, or a new one charged to the ledger first."""
    key = judge_key(name, judge._judge_model(), image_sha(image), extra)
    hit = jcache.load(key)
    if hit is not None:
        return hit | {"cached": True}
    ledger.charge(calls * JUDGE_CALL_FLAT)
    result = await run()
    verdict = {"score": result.score, "rationale": result.rationale}
    # Do not keep a failed call: the next run must ask again.
    if not result.rationale.startswith(judge._UNPARSEABLE_PREFIX):
        jcache.store(key, verdict)
    return verdict


async def _judge_snap(
    row: dict[str, Any], image: bytes, map_png: bytes, jcache: JudgeCache, ledger: Ledger
) -> None:
    spec = {k: row["spec"][k] for k in ("objects", "ground")}
    row["spec_score"] = await _judged(
        f"spec_conformance_x{SPEC_SAMPLES}", image, params_sha(spec), SPEC_SAMPLES,
        lambda: judge.median_of(SPEC_SAMPLES, lambda: judge.score_spec_conformance(image, spec)),
        jcache, ledger,
    )
    row["style_score"] = await _judged(
        "style_pair", image, image_sha(map_png), 1,
        lambda: judge.score_style_pair(map_png, image), jcache, ledger,
    )


async def _judge_entity(
    label: str, visual: str, a: bytes, b: bytes, jcache: JudgeCache, ledger: Ledger
) -> dict[str, Any]:
    return await _judged(
        "entity_consistency", a, text_sha(label + visual) + image_sha(b), 1,
        lambda: judge.score_entity_consistency(label, visual, a, b), jcache, ledger,
    )


def _video_row(out: Path, name: str, blob: bytes) -> dict[str, Any]:
    (out / name).write_bytes(blob)
    return {
        "file": name,
        "meta": audit_frames(out / name),
        "snap": snap_stats(deltas(gray_frames(out / name))),
    }


async def build(
    run_dir: Path, out: Path, *, ledger: Ledger, cache: CellCache, jcache: JudgeCache
) -> dict[str, Any]:
    """Fetch, measure and judge one run; write report.json and review.html."""
    request = json.loads((run_dir / "request.json").read_text())
    response = json.loads((run_dir / "response.json").read_text())
    route_path = run_dir / "route.json"
    route = json.loads(route_path.read_text()) if route_path.exists() else None
    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(run_dir / "map.png", out / "map.png")
    map_png = (out / "map.png").read_bytes()
    report: dict[str, Any] = {
        "run": run_dir.name,
        "judge_model": judge._judge_model(),
        "cap_usd": ledger.cap_usd,
        "legs": [],
        "merged": None,
        "snaps": [],
        "entities": [],
        "stopped_reason": None,
    }
    last_frames: dict[int, bytes] = {}
    for clip in response.get("clips") or []:
        stem = f"leg-{clip['from_shot']}-{clip['to_shot']}"
        row = _video_row(out, f"{stem}.mp4", fetch(clip["video_url"], cache))
        # audit_frames writes 5 frames at 0/25/50/75/100%; frame 4 is the last one.
        last_frames[clip["to_shot"]] = (out / f"{stem}-frame-4.jpg").read_bytes()
        report["legs"].append(
            {k: clip.get(k) for k in ("from_shot", "to_shot", "model", "seconds")} | row
        )
    if response.get("video_url"):
        report["merged"] = _video_row(out, "walk.mp4", fetch(response["video_url"], cache))

    frames: dict[int, bytes] = {}
    try:
        for point in snap_points(request, response):
            url = point.pop("image_url")
            image = fetch(url, cache) if url else last_frames.get(point["index"])
            if image is None:
                continue
            frames[point["index"]] = image
            point["frame"] = f"snap-{point['index']}.jpg"
            (out / point["frame"]).write_bytes(image)
            report["snaps"].append(point)
            await _judge_snap(point, image, map_png, jcache, ledger)
        for label, visual, first, last in entity_pairs(report["snaps"]):
            verdict = await _judge_entity(
                label, visual, frames[first["index"]], frames[last["index"]], jcache, ledger
            )
            report["entities"].append(
                {"label": label, "from": first["index"], "to": last["index"]} | verdict
            )
    except BudgetExceeded as exc:
        report["stopped_reason"] = str(exc)
    report["spent_usd"] = round(ledger.spent_usd, 4)
    report["summary"] = summarise(report)
    (out / "report.json").write_text(json.dumps(report, indent=1))
    (out / "review.html").write_text(review_html(report, route, map_size(out / "map.png")))
    return report


def summarise(report: dict[str, Any]) -> dict[str, Any]:
    """The per-claim numbers the plan's verification reads."""
    ratios = [leg["snap"]["ratio"] for leg in report["legs"] if "ratio" in leg["snap"]]
    maxes = [leg["snap"]["max"] for leg in report["legs"] if "max" in leg["snap"]]
    merged = (report.get("merged") or {}).get("snap", {})
    return {
        "spec_min": min(
            (s["spec_score"]["score"] for s in report["snaps"] if "spec_score" in s), default=None
        ),
        "style_min": min(
            (s["style_score"]["score"] for s in report["snaps"] if "style_score" in s), default=None
        ),
        "entity_min": min((e["score"] for e in report["entities"]), default=None),
        "leg_max_delta": max(maxes, default=None),
        "leg_worst_ratio": max(ratios, default=None),
        "merged_max_delta": merged.get("max"),
        "merged_ratio": merged.get("ratio"),
    }


def map_size(path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as im:
        return im.size


def _xy(p: Any) -> tuple[float, float]:
    return (p["x"], p["y"]) if isinstance(p, dict) else (p[0], p[1])


def route_svg(route: dict[str, Any], size: tuple[int, int]) -> str:
    """The route and its checkpoints (with gaze) over the map, in map pixels."""
    w, h = size
    frame = route.get("frame") or {"x": 0, "y": 0, "w": 100, "h": 60}

    def px(p: Any) -> tuple[float, float]:
        x, y = _xy(p)
        return (x - frame["x"]) / frame["w"] * w, (y - frame["y"]) / frame["h"] * h

    points = route.get("points") or route.get("path") or []  # path: the older scratch name
    line = " ".join(f"{x:.1f},{y:.1f}" for x, y in map(px, points))
    r = w / 120
    marks = []
    for n, cp in enumerate(route.get("checkpoints") or [], 1):
        x, y = px(cp)
        gaze = float(cp.get("gaze", 0.0)) if isinstance(cp, dict) else 0.0
        gx, gy = x + 4 * r * math.cos(gaze), y + 4 * r * math.sin(gaze)
        marks.append(
            f'<line x1="{x:.1f}" y1="{y:.1f}" x2="{gx:.1f}" y2="{gy:.1f}" stroke="#f5b800" stroke-width="{r / 2:.1f}"/>'
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#fff" stroke="#d62839" stroke-width="{r / 3:.1f}"/>'
            f'<text x="{x:.1f}" y="{y + r / 2.5:.1f}" font-size="{r * 1.2:.1f}" text-anchor="middle" fill="#d62839">{n}</text>'
        )
    return (
        f'<svg viewBox="0 0 {w} {h}" aria-label="Route on the map">'
        f'<polyline points="{line}" fill="none" stroke="#d62839" stroke-width="{r / 2:.1f}" stroke-opacity=".85"/>'
        f"{''.join(marks)}</svg>"
    )


def _score(v: dict[str, Any] | None) -> str:
    if not v:
        return "<b>—</b>"
    return f"<b>{v['score']:g}</b> {html.escape(str(v.get('rationale', '')))}"


def _snap_cell(stats: dict[str, Any]) -> str:
    if "max" not in stats:
        return "no frames"
    return (
        f"median {stats['median']}, max {stats['max']} at {stats['max_at']:.0%}, "
        f"ratio {stats['ratio']}"
    )


def review_html(
    report: dict[str, Any], route: dict[str, Any] | None, size: tuple[int, int]
) -> str:
    esc = html.escape
    video = (report.get("merged") or {}).get("file") or next(
        (leg["file"] for leg in report["legs"]), None
    )
    top = (
        '<div class="pair"><figure><div class="map"><img src="map.png" alt="Town map">'
        + (route_svg(route, size) if route else "")
        + "</div><figcaption>Route on the map</figcaption></figure>"
        + (
            f'<figure><video controls playsinline preload="metadata" src="{esc(video)}"></video>'
            "<figcaption>The walk</figcaption></figure>"
            if video
            else "<p>No video in this run.</p>"
        )
        + "</div>"
    )
    legs = "".join(
        f"<tr><td>{leg['from_shot']} → {leg['to_shot']}</td><td>{esc(str(leg.get('model')))}</td>"
        f"<td>{_snap_cell(leg['snap'])}</td><td>"
        + "".join(
            f'<img class="thumb" src="{esc(Path(leg["file"]).stem)}-frame-{i}.jpg" alt="">'
            for i in range(5)
        )
        + "</td></tr>"
        for leg in report["legs"]
    )
    merged = report.get("merged")
    snaps = []
    for s in report["snaps"]:
        objects = "".join(
            f"<li>{esc(str(o.get('label')))} <small>{esc(str(o.get('h_pos', '')))}, "
            f"{esc(str(o.get('size', '')))}</small></li>"
            for o in s["spec"]["objects"]
        ) or "<li><i>none</i></li>"
        ground = "".join(
            f"<li>{esc(str(g.get('label')))} on the {esc(str(g.get('side')))}</li>"
            for g in s["spec"]["ground"]
        ) or "<li><i>none</i></li>"
        reported = (
            f"<p>Walk said: conformance {s['conformance']}, corrected {s['corrected']}</p>"
            if s.get("conformance") is not None or s.get("corrected") is not None
            else ""
        )
        snaps.append(
            f'<section class="pair"><figure><img src="{esc(s["frame"])}" alt="Snap {s["index"]}">'
            f"<figcaption>Snap point {s['index']}</figcaption></figure><div>"
            f"<h3>Spec, left to right</h3><ol>{objects}</ol><h3>Ground</h3><ul>{ground}</ul>"
            f"<p>Spec: {_score(s.get('spec_score'))}</p><p>Style vs map: {_score(s.get('style_score'))}</p>"
            f"{reported}</div></section>"
        )
    entities = "".join(
        f"<tr><td>{esc(e['label'])}</td><td>{e['from']} → {e['to']}</td><td>{_score(e)}</td></tr>"
        for e in report["entities"]
    )
    summary = "".join(f"<li>{esc(k)}: {v}</li>" for k, v in report["summary"].items())
    stopped = (
        f"<p class=\"warn\">Stopped: {esc(report['stopped_reason'])}</p>"
        if report.get("stopped_reason")
        else ""
    )
    return (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>Walk bench {esc(report['run'])}</title><style>"
        "body{margin:0;background:#f4f5f6;color:#181c20;font:15px system-ui}"
        "main{max-width:1200px;margin:auto;padding:16px}"
        ".pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;"
        "border-top:1px solid #bbb;padding:12px 0}"
        "figure{margin:0}.map{position:relative}.map svg{position:absolute;inset:0;width:100%;height:100%}"
        "img,video{display:block;width:100%}video{background:#161616}"
        ".thumb{display:inline-block;width:19%;margin-right:1%}"
        "table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;"
        "padding:6px;text-align:left;vertical-align:top}.warn{color:#b00020}"
        "h3{font-size:15px;margin:8px 0 4px}"
        "@media(max-width:600px){.pair{grid-template-columns:1fr}}</style><main>"
        f"<h1>Walk bench: {esc(report['run'])}</h1>"
        f"<p>Judge {esc(report['judge_model'])}, spent ${report['spent_usd']} of "
        f"${report['cap_usd']}.</p>{stopped}<ul>{summary}</ul>{top}"
        + (f"<p>Merged video snaps: {_snap_cell(merged['snap'])}</p>" if merged else "")
        + "<h2>Legs</h2><table><tr><th>Leg</th><th>Model</th><th>Snap metric</th>"
        f"<th>Frames 0-100%</th></tr>{legs}</table>"
        f"<h2>Snap points</h2>{''.join(snaps)}"
        "<h2>Same landmark at two snap points</h2><table><tr><th>Label</th><th>Snaps</th>"
        f"<th>Score</th></tr>{entities}</table>"
        '<p><a href="report.json">report.json</a></p></main></html>'
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    run_dir = args.run_dir.resolve()
    if os.environ.get("WALK_BENCH_RUN") != "1":
        print(json.dumps(plan(run_dir), indent=1))
        print("Dry run: nothing fetched or judged. Set WALK_BENCH_RUN=1 to run it.")
        return 0
    from providers import mock
    from tests.matrix_bench.runner import _load_env

    _load_env()
    if mock.on():
        raise SystemExit("MOCK_PROVIDERS is on: mock judges are not a real verdict")
    out = args.out or _HERE / "reports" / run_dir.name
    ledger = Ledger(cap_usd=float(os.environ.get("WALK_BENCH_BUDGET_USD", "0.5")))
    cache = CellCache(_HERE / "cache")
    report = asyncio.run(build(run_dir, out, ledger=ledger, cache=cache, jcache=JudgeCache(cache.root)))
    print(json.dumps(report["summary"], indent=1))
    print(f"spent ${report['spent_usd']}; review: {out / 'review.html'}")
    return 0 if report["stopped_reason"] is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
