#!/usr/bin/env python3
"""Compose a short journey film from a map still and a descent clip.

This is the reusable version of the hand-built "journey-in-and-out" cut:
map still -> tap cue -> generated camera dive -> arrived page -> reverse dive
-> same map -> quick re-enter -> closing card.

The raw Playwright capture is still the audit artifact. This script makes the
watchable cut from the same receipts without depending on ffmpeg drawtext,
which is not available in the default Homebrew build used for these demos.
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
DEFAULT_MAP = HERE / "studies" / "seed" / "ankh-morpork.jpg"
DEFAULT_OUT = HERE / "studies" / "journey-film.mp4"
SIZE = (1920, 1080)
FPS = 24

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError as exc:  # pragma: no cover - exercised by local setup only
    venv_python = REPO_ROOT / "apps" / "modal-backend" / ".venv" / "bin" / "python"
    if venv_python.exists() and Path(sys.executable).resolve() != venv_python.resolve():
        os.execv(str(venv_python), [str(venv_python), *sys.argv])
    raise SystemExit(
        "Pillow is required. Install it in this environment, then rerun this script."
    ) from exc


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Build the short map -> place -> map journey film."
    )
    p.add_argument(
        "--map",
        type=Path,
        default=DEFAULT_MAP,
        help=f"map still to start from (default: {DEFAULT_MAP})",
    )
    p.add_argument(
        "--dive",
        type=Path,
        required=True,
        help="first+last-frame descent clip, usually from the app's Descend button",
    )
    p.add_argument(
        "--arrival",
        type=Path,
        help="optional arrived-page still; defaults to the last frame of --dive",
    )
    p.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUT,
        help=f"output MP4 (default: {DEFAULT_OUT})",
    )
    p.add_argument("--place", default="The Mended Drum", help="place name for captions")
    p.add_argument(
        "--ffmpeg",
        default=shutil.which("ffmpeg") or "ffmpeg",
        help="ffmpeg binary to use",
    )
    p.add_argument("--fps", type=int, default=FPS, help="output frame rate")
    p.add_argument(
        "--keep-work",
        action="store_true",
        help="keep the temporary segment directory for debugging",
    )
    return p.parse_args()


def run(args: Iterable[str | Path]) -> None:
    argv = [str(a) for a in args]
    print("+", shlex.join(argv))
    subprocess.run(argv, check=True)


def require_file(path: Path, label: str) -> None:
    if not path.exists():
        raise SystemExit(f"{label} does not exist: {path}")


def load_font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    names = (
        [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf",
        ]
        if bold
        else [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    )
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def fit_cover(src: Path, size: tuple[int, int] = SIZE) -> Image.Image:
    img = Image.open(src).convert("RGB")
    iw, ih = img.size
    ow, oh = size
    scale = max(ow / iw, oh / ih)
    nw, nh = round(iw * scale), round(ih * scale)
    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - ow) // 2
    top = (nh - oh) // 2
    return img.crop((left, top, left + ow, top + oh))


def text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> int:
    box = draw.textbbox((0, 0), text, font=font, stroke_width=1)
    return box[2] - box[0]


def wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    max_width: int,
) -> list[str]:
    words = text.split()
    lines: list[str] = []
    line = ""
    for word in words:
        trial = f"{line} {word}".strip()
        if line and text_width(draw, trial, font) > max_width:
            lines.append(line)
            line = word
        else:
            line = trial
    if line:
        lines.append(line)
    return lines or [""]


def caption_layer(
    text: str,
    *,
    top: bool = False,
    font_size: int = 44,
    max_width: int = 1500,
) -> Image.Image:
    layer = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    font = load_font(font_size, bold=True)
    lines = wrap_text(draw, text, font, max_width)
    line_heights = [
        draw.textbbox((0, 0), line, font=font, stroke_width=1)[3]
        - draw.textbbox((0, 0), line, font=font, stroke_width=1)[1]
        for line in lines
    ]
    gap = 10
    pad_x = 34
    pad_y = 20
    text_h = sum(line_heights) + gap * (len(lines) - 1)
    text_w = max(text_width(draw, line, font) for line in lines)
    box_w = text_w + pad_x * 2
    box_h = text_h + pad_y * 2
    x0 = (SIZE[0] - box_w) // 2
    y0 = 44 if top else SIZE[1] - box_h - 58
    draw.rounded_rectangle(
        (x0, y0, x0 + box_w, y0 + box_h),
        radius=28,
        fill=(0, 0, 0, 150),
        outline=(255, 255, 255, 38),
        width=1,
    )
    y = y0 + pad_y
    for line, h in zip(lines, line_heights, strict=True):
        tw = text_width(draw, line, font)
        draw.text(
            ((SIZE[0] - tw) // 2, y),
            line,
            font=font,
            fill=(255, 255, 255, 238),
            stroke_width=2,
            stroke_fill=(0, 0, 0, 180),
        )
        y += h + gap
    return layer


def render_still(src: Path, caption: str, out: Path, *, top: bool = False) -> None:
    base = fit_cover(src).convert("RGBA")
    base.alpha_composite(caption_layer(caption, top=top))
    base.convert("RGB").save(out, quality=94)


def render_title_card(src: Path, title: str, subtitle: str, out: Path) -> None:
    base = fit_cover(src).filter(ImageFilter.GaussianBlur(5)).convert("RGBA")
    scrim = Image.new("RGBA", SIZE, (0, 0, 0, 112))
    base.alpha_composite(scrim)
    draw = ImageDraw.Draw(base)
    title_font = load_font(76, bold=True)
    sub_font = load_font(34, bold=False)
    title_lines = wrap_text(draw, title, title_font, 1420)
    sub_lines = wrap_text(draw, subtitle, sub_font, 1350)
    y = 410
    for line in title_lines:
        box = draw.textbbox((0, 0), line, font=title_font, stroke_width=2)
        x = (SIZE[0] - (box[2] - box[0])) // 2
        draw.text(
            (x, y),
            line,
            font=title_font,
            fill=(255, 255, 255, 245),
            stroke_width=3,
            stroke_fill=(0, 0, 0, 210),
        )
        y += 86
    y += 22
    for line in sub_lines:
        box = draw.textbbox((0, 0), line, font=sub_font, stroke_width=1)
        x = (SIZE[0] - (box[2] - box[0])) // 2
        draw.text(
            (x, y),
            line,
            font=sub_font,
            fill=(240, 240, 232, 235),
            stroke_width=2,
            stroke_fill=(0, 0, 0, 180),
        )
        y += 46
    base.convert("RGB").save(out, quality=94)


def make_still_video(ffmpeg: str, image: Path, duration: float, out: Path, fps: int) -> None:
    run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-loop",
            "1",
            "-t",
            f"{duration:.3f}",
            "-i",
            image,
            "-vf",
            f"fps={fps},format=yuv420p",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            out,
        ]
    )


def render_overlay_png(caption: str, out: Path, *, top: bool = False) -> None:
    caption_layer(caption, top=top).save(out)


def make_video_segment(
    ffmpeg: str,
    video: Path,
    overlay: Path,
    out: Path,
    fps: int,
    *,
    reverse: bool = False,
    speed: float = 1.0,
) -> None:
    filters = [
        f"scale={SIZE[0]}:{SIZE[1]}:force_original_aspect_ratio=increase",
        f"crop={SIZE[0]}:{SIZE[1]}",
        "setsar=1",
    ]
    if reverse:
        filters.extend(["reverse", "setpts=PTS-STARTPTS"])
    elif speed != 1.0:
        filters.append(f"setpts=PTS/{speed:.4f}")
    filters.extend([f"fps={fps}", "format=rgba"])
    filter_complex = (
        f"[0:v]{','.join(filters)}[v];"
        "[v][1:v]overlay=0:0,format=yuv420p[out]"
    )
    run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-i",
            video,
            "-i",
            overlay,
            "-filter_complex",
            filter_complex,
            "-map",
            "[out]",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            out,
        ]
    )


def extract_last_frame(ffmpeg: str, video: Path, out: Path) -> None:
    run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-sseof",
            "-0.12",
            "-i",
            video,
            "-frames:v",
            "1",
            "-update",
            "1",
            out,
        ]
    )


def concat_segments(ffmpeg: str, segments: list[Path], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    list_file = segments[0].parent / "concat.txt"
    joined = segments[0].parent / "joined.mp4"
    with list_file.open("w", encoding="utf-8") as f:
        for segment in segments:
            escaped = str(segment.resolve()).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
    run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_file,
            "-c",
            "copy",
            joined,
        ]
    )
    run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-i",
            joined,
            "-vf",
            "scale=in_range=pc:out_range=tv,format=yuv420p",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-color_range",
            "tv",
            "-movflags",
            "+faststart",
            out,
        ]
    )


def main() -> None:
    args = parse_args()
    require_file(args.map, "map")
    require_file(args.dive, "dive")

    work_ctx = tempfile.TemporaryDirectory(prefix="journey-film-")
    work = Path(work_ctx.name)
    if args.keep_work:
        work_ctx.cleanup()
        work.mkdir(parents=True, exist_ok=True)

    try:
        arrival = args.arrival or (work / "arrival.jpg")
        if args.arrival:
            require_file(arrival, "arrival")
        else:
            extract_last_frame(args.ffmpeg, args.dive, arrival)

        stills = {
            "intro": work / "intro.jpg",
            "tap": work / "tap.jpg",
            "arrival": work / "arrival_caption.jpg",
            "map_back": work / "map_back.jpg",
            "end": work / "end.jpg",
        }
        render_still(
            args.map,
            "A detailed map becomes an explorable world.",
            stills["intro"],
            top=True,
        )
        render_still(args.map, f"Tap {args.place}.", stills["tap"])
        render_still(
            arrival,
            f"Inside: {args.place}, exactly where the map put it.",
            stills["arrival"],
        )
        render_still(
            args.map,
            "Back out: the same saved map, not a re-roll.",
            stills["map_back"],
        )
        render_title_card(
            args.map,
            "In and out stay consistent.",
            "The transition is generated, but its first and last frames are real session pages.",
            stills["end"],
        )

        overlays = {
            "dive": work / "dive_overlay.png",
            "reverse": work / "reverse_overlay.png",
            "again": work / "again_overlay.png",
        }
        render_overlay_png("Camera dive: map -> place.", overlays["dive"])
        render_overlay_png("Step back out: place -> same map.", overlays["reverse"])
        render_overlay_png("Re-enter: the same place opens again.", overlays["again"])

        segments: list[Path] = []
        for name, image, duration in [
            ("01_intro", stills["intro"], 2.6),
            ("02_tap", stills["tap"], 2.0),
        ]:
            out = work / f"{name}.mp4"
            make_still_video(args.ffmpeg, image, duration, out, args.fps)
            segments.append(out)

        dive_in = work / "03_dive_in.mp4"
        make_video_segment(args.ffmpeg, args.dive, overlays["dive"], dive_in, args.fps)
        segments.append(dive_in)

        arrival_seg = work / "04_arrival.mp4"
        make_still_video(args.ffmpeg, stills["arrival"], 2.6, arrival_seg, args.fps)
        segments.append(arrival_seg)

        reverse = work / "05_reverse.mp4"
        make_video_segment(
            args.ffmpeg,
            args.dive,
            overlays["reverse"],
            reverse,
            args.fps,
            reverse=True,
        )
        segments.append(reverse)

        back = work / "06_map_back.mp4"
        make_still_video(args.ffmpeg, stills["map_back"], 2.0, back, args.fps)
        segments.append(back)

        again = work / "07_dive_again.mp4"
        make_video_segment(
            args.ffmpeg,
            args.dive,
            overlays["again"],
            again,
            args.fps,
            speed=1.4,
        )
        segments.append(again)

        end = work / "08_end.mp4"
        make_still_video(args.ffmpeg, stills["end"], 2.4, end, args.fps)
        segments.append(end)

        concat_segments(args.ffmpeg, segments, args.output)
        print(f"wrote {args.output}")
        if args.keep_work:
            print(f"kept work dir: {work}")
    finally:
        if not args.keep_work:
            work_ctx.cleanup()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.returncode) from exc
