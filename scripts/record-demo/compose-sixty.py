#!/usr/bin/env python3
"""Cut a feature-study recording into a short, watchable film.

    ./compose-sixty.py studies/raw/sixty-second-tour/<clip>.webm out.mp4 [extra.mp4 ...]

The recording is honest but slow: it waits on real generations, and during
those waits the page is not still (a draft repaints), so motion alone cannot
separate a wait from an interaction. The study says instead: every caption it
writes lands in beats.json beside the video.

Each beat keeps its head and tail at real speed; only a long middle is sped
up, so what you see happen, happens at the speed it happened. Extra clips are
appended untouched. The receipt says what each beat cost and what was sped.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

WORK_W, WORK_H = 160, 100
LIVE_RATE = 1.25  # interactions: barely faster than life
DEAD_RATE = 10.0  # a wait, compressed
DEAD_MIN_S = 0.5  # ...but never shorter than this, or a beat flickers past
MOTION_FLOOR = 0.9  # mean abs 8-bit change per pixel that counts as "moving"
TARGET_S = 62.0  # a social cut
BEAT_HEAD_S = 2.2  # real speed at the start of a beat: the action itself
BEAT_TAIL_S = 1.6  # ...and at the end: the result, readable
TAIL_MARGIN_S = 1.2  # stop before the beat ends, or the tail shows the NEXT action
MIDDLE_MAX_S = 1.4  # whatever sat between them, compressed to at most this
# The capture is 16:10; fit it inside 1080p rather than overflowing the pad.
SCALE = ("scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,"
         "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x15120e")


def probe_fps(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=avg_frame_rate", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    num, _, den = out.partition("/")
    return float(num) / float(den or 1)


def motion(path: Path) -> np.ndarray:
    """Movement in the PAGE, not the chrome: the generation waterfall and the
    session graph animate throughout a wait and would otherwise read as
    interaction, leaving nothing to compress."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf",
         f"crop=iw:ih*0.70:0:ih*0.26,scale={WORK_W}:{WORK_H},format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, WORK_H, WORK_W).astype(np.float32)
    return np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))


def segments(live: np.ndarray, fps: float) -> list[tuple[float, float, bool]]:
    """Consecutive [start, end, is_live] spans, in seconds."""
    spans: list[tuple[float, float, bool]] = []
    start, state = 0, bool(live[0])
    for i, value in enumerate(live[1:], start=1):
        if bool(value) != state:
            spans.append((start / fps, i / fps, state))
            start, state = i, bool(value)
    spans.append((start / fps, len(live) / fps, state))
    return spans


def smooth(live: np.ndarray, fps: float) -> np.ndarray:
    """A gap of a few still frames mid-interaction is not a wait, and a
    progress bar ticking inside a 40-second wait is not an interaction."""
    window = max(1, int(round(fps * 0.6)))
    padded = np.pad(live.astype(np.float32), window, mode="edge")
    rolled = np.convolve(padded, np.ones(window * 2 + 1), "same")[window:-window] > 0
    run_min = max(1, int(round(fps * MIN_RUN_S)))
    out = rolled.copy()
    start = 0
    for i in range(1, len(out) + 1):
        if i == len(out) or out[i] != out[start]:
            if i - start < run_min and start > 0 and i < len(out):
                out[start:i] = out[start - 1]  # too short to be its own beat
            start = i
    return out


def rates_for(spans: list[tuple[float, float, bool]]) -> tuple[float, float]:
    """Pick the gentlest speed-up that still lands near TARGET_S."""
    live_rate, dead_rate = LIVE_RATE, DEAD_RATE
    for _ in range(40):
        total = sum(
            (end - start) / (live_rate if is_live else min(dead_rate, max(1.0, (end - start) / DEAD_MIN_S)))
            for start, end, is_live in spans)
        if total <= TARGET_S:
            break
        if dead_rate < MAX_DEAD_RATE:
            dead_rate = min(MAX_DEAD_RATE, dead_rate * 1.35)
        elif live_rate < MAX_LIVE_RATE:
            live_rate = min(MAX_LIVE_RATE, live_rate * 1.1)
        else:
            break
    return live_rate, dead_rate


def beat_spans(beats_file: Path, clip_s: float) -> list[tuple[float, float, str]]:
    data = json.loads(beats_file.read_text())
    marks = [(b["at_ms"] / 1000.0, b["text"]) for b in data.get("beats", [])]
    spans: list[tuple[float, float, str]] = []
    for index, (at, text) in enumerate(marks):
        end = marks[index + 1][0] if index + 1 < len(marks) else clip_s
        if end - at > 0.4:
            spans.append((at, min(end, clip_s), text))
    return spans


def piece(source: Path, work: Path, name: str, start: float, span: float, rate: float) -> Path:
    out = work / f"{name}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{span:.3f}", "-i", str(source),
         "-vf", f"setpts=PTS/{rate:.3f},{SCALE},fps=30", "-an",
         "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(out)],
        check=True)
    return out


def main() -> None:
    source, out = Path(sys.argv[1]), Path(sys.argv[2])
    extras = [Path(a) for a in sys.argv[3:]]
    work = out.parent / "_compose"
    work.mkdir(parents=True, exist_ok=True)

    clip_s = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(source)],
        capture_output=True, text=True, check=True).stdout)
    spans = beat_spans(source.parent / "beats.json", clip_s)
    # BEATS_RANGE="0:6" keeps the first six beats: a take can hold material
    # that belongs to a different part of the cut.
    if os.environ.get("BEATS_RANGE"):
        first, _, last = os.environ["BEATS_RANGE"].partition(":")
        spans = spans[int(first or 0):int(last or len(spans))]
    if not spans:
        raise SystemExit("no beats.json beside the recording — re-record with the current harness")

    parts, receipt = [], []
    for index, (start, end, text) in enumerate(spans):
        span = end - start
        # The beat ends when the NEXT caption is written, which is the moment
        # the next action starts; back off so the tail shows this beat's result.
        usable_end = max(start + 0.4, end - (TAIL_MARGIN_S if span > BEAT_HEAD_S + TAIL_MARGIN_S else 0.0))
        usable = usable_end - start
        head = min(BEAT_HEAD_S, usable)
        tail = min(BEAT_TAIL_S, max(0.0, usable - head))
        middle = max(0.0, usable - head - tail)
        kept = head + tail
        parts.append(piece(source, work, f"b{index:03d}h", start, head, 1.0))
        if middle > 0.6:
            rate = max(1.0, middle / MIDDLE_MAX_S)
            parts.append(piece(source, work, f"b{index:03d}m", start + head, middle, rate))
            kept += middle / rate
        if tail > 0.2:
            parts.append(piece(source, work, f"b{index:03d}t", usable_end - tail, tail, 1.0))
        receipt.append({"beat": text, "from_s": round(start, 2), "raw_s": round(span, 2), "tail_margin_s": TAIL_MARGIN_S,
                        "kept_s": round(kept, 2), "middle_speed": round(max(1.0, middle / MIDDLE_MAX_S), 1) if middle > 0.6 else 1.0})

    for extra in extras:
        out_piece = work / f"x{extra.stem}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(extra), "-vf", f"{SCALE},fps=30", "-an",
             "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(out_piece)],
            check=True)
        parts.append(out_piece)
        receipt.append({"appended": extra.name, "kept_s": None})

    listing = work / "concat.txt"
    listing.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
         "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", str(out)],
        check=True)

    duration = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(out)],
        capture_output=True, text=True, check=True).stdout)
    out.with_suffix(".receipt.json").write_text(json.dumps({
        "source": str(source), "source_seconds": round(clip_s, 1), "appended": [e.name for e in extras],
        "rule": {"head_s": BEAT_HEAD_S, "tail_s": BEAT_TAIL_S, "middle_max_s": MIDDLE_MAX_S, "target_s": TARGET_S},
        "beats": receipt, "duration_s": round(duration, 2),
    }, indent=1))
    print(json.dumps({"out": str(out), "duration_s": round(duration, 2), "beats": len(spans)}))


if __name__ == "__main__":
    main()
