#!/usr/bin/env python3
"""Offline, source-pixel lighthouse film. No image providers or network access."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "apps/modal-backend/tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg"
SIZE = (1920, 1080)
FPS = 30
DURATION = 13
SELECT_START = .9
APPROACH_START = 1.5
APPROACH_END = 4.1
RETURN_START = 6.3
RETURN_END = 9.3
# Manually reviewed tower bounds include the floating crystal and the stone base.
LANDMARK = (.082, .074, .127, .438)
TAP = (.138, .312)
PADDING = .045


def smooth(value: float) -> float:
    value = min(1.0, max(0.0, value))
    return value * value * (3 - 2 * value)


def crop_for_landmark() -> tuple[float, float, float]:
    x, y, w, h = LANDMARK
    fraction = max(.42, w + PADDING * 2, h + PADDING * 2)

    def origin(point: float, low: float, length: float) -> float:
        lower = max(0.0, low + length + PADDING - fraction)
        upper = min(1 - fraction, low - PADDING)
        return min(upper, max(lower, point - fraction / 2))

    return origin(TAP[0], x, w), origin(TAP[1], y, h), fraction


def progress_at(time: float) -> float:
    if time < APPROACH_START:
        return 0.0
    if time < APPROACH_END:
        return smooth((time - APPROACH_START) / (APPROACH_END - APPROACH_START))
    if time < RETURN_START:
        return 1.0
    if time < RETURN_END:
        return 1 - smooth((time - RETURN_START) / (RETURN_END - RETURN_START))
    return 0.0


def transform_at(time: float) -> tuple[float, float, float]:
    x, y, fraction = crop_for_landmark()
    progress = progress_at(time)
    # Same uniform affine interpolation as sampleReframe in the app. The film
    # uses reviewed landmark framing and editorial timing, not production values.
    return 1 + (1 / fraction - 1) * progress, -x / fraction * progress, -y / fraction * progress


def source_frame(source: Image.Image, time: float) -> Image.Image:
    scale, tx, ty = transform_at(time)
    fit = min(SIZE[0] / source.width, SIZE[1] / source.height)
    width, height = round(source.width * fit), round(source.height * fit)
    region = (
        -tx / scale * source.width,
        -ty / scale * source.height,
        (1 - tx) / scale * source.width,
        (1 - ty) / scale * source.height,
    )
    pixels = source.transform((width, height), Image.Transform.EXTENT, region, Image.Resampling.BICUBIC)
    frame = Image.new("RGB", SIZE, "#080d10")
    frame.paste(pixels, ((SIZE[0] - width) // 2, (SIZE[1] - height) // 2))
    return frame


@lru_cache
def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "Arial Bold.ttf" if bold else "Arial.ttf"
    for root in (Path("/System/Library/Fonts/Supplemental"), Path("/Library/Fonts")):
        path = root / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    raise RuntimeError("Arial is required for this film's audited typography")


def opacity(time: float, start: float, end: float) -> float:
    return min(smooth((time - start) / .3), smooth((end - time) / .3))


def title(frame: Image.Image, heading: str, subheading: str, alpha: float, *, right: bool = False) -> Image.Image:
    if alpha <= 0:
        return frame
    layer = Image.new("RGBA", SIZE)
    draw = ImageDraw.Draw(layer)
    # A restrained bottom scrim keeps the artwork legible; no blur or restyling.
    for y in range(790, SIZE[1]):
        draw.line((0, y, SIZE[0], y), fill=(4, 10, 16, round(180 * alpha * (y - 790) / 290)))
    heading_font, subheading_font = font(58, True), font(25)
    x = SIZE[0] - 72 - draw.textlength(heading, font=heading_font) if right else 72
    draw.text((x, 896), heading, font=heading_font, fill=(255, 255, 255, round(255 * alpha)), stroke_width=1, stroke_fill=(0, 0, 0, round(140 * alpha)))
    draw.text((x + 2, 975), subheading, font=subheading_font, fill=(235, 243, 248, round(245 * alpha)))
    return Image.alpha_composite(frame.convert("RGBA"), layer).convert("RGB")


def selection_cue(frame: Image.Image, source_size: tuple[int, int], time: float) -> Image.Image:
    if not SELECT_START <= time < APPROACH_START:
        return frame
    fit = min(SIZE[0] / source_size[0], SIZE[1] / source_size[1])
    width, height = round(source_size[0] * fit), round(source_size[1] * fit)
    x = (SIZE[0] - width) // 2 + TAP[0] * width
    y = (SIZE[1] - height) // 2 + TAP[1] * height
    progress = (time - SELECT_START) / (APPROACH_START - SELECT_START)
    alpha = opacity(time, SELECT_START, APPROACH_START)
    radius = 18 + 26 * smooth(progress)
    layer = Image.new("RGBA", SIZE)
    draw = ImageDraw.Draw(layer)
    bounds = (x - radius, y - radius, x + radius, y + radius)
    draw.ellipse(bounds, outline=(4, 10, 16, round(180 * alpha)), width=7)
    draw.ellipse(bounds, outline=(255, 255, 255, round(255 * alpha)), width=3)
    draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(255, 255, 255, round(255 * alpha)))
    return Image.alpha_composite(frame.convert("RGBA"), layer).convert("RGB")


def film_frame(source: Image.Image, time: float) -> Image.Image:
    frame = source_frame(source, time)
    if time < SELECT_START:
        frame = title(frame, "openflipbook", "The Crystal Lighthouse", opacity(time, -.3, SELECT_START))
    elif APPROACH_END <= time < RETURN_START:
        frame = title(frame, "The Crystal Lighthouse", "A closer look.", opacity(time, APPROACH_END, RETURN_START), right=True)
    elif time >= 10.8:
        frame = title(frame, "openflipbook", "Back to the map.", opacity(time, 10.8, DURATION + .3))
    return selection_cue(frame, source.size, time)


def verify_geometry() -> None:
    bx, by, bw, bh = LANDMARK
    for index in range(FPS * DURATION):
        scale, tx, ty = transform_at(index / FPS)
        assert tx <= 1e-9 and ty <= 1e-9
        assert tx + scale >= 1 - 1e-9 and ty + scale >= 1 - 1e-9
        for x, y in ((bx, by), (bx + bw, by + bh), TAP):
            assert 0 <= scale * x + tx <= 1
            assert 0 <= scale * y + ty <= 1
    assert transform_at(0) == transform_at(DURATION)


def audio_filter() -> str:
    # Original synthesized sound design: a quiet surf-like bed and three soft
    # bell accents. No samples, music downloads, or third-party recordings.
    pulses = [(SELECT_START + .12, 392.0), (APPROACH_END, 587.33), (RETURN_END, 392.0)]
    tones = []
    for start, frequency in pulses:
        dt = f"(t-{start})"
        tones.append(f"if(gte(t,{start}),0.065*exp(-2.4*{dt})*(1-exp(-45*{dt}))*(sin(2*PI*{frequency}*{dt})+0.25*sin(2*PI*{frequency * 2.003}*{dt})),0)")
    bells = "+".join(tones)
    return (
        f"anoisesrc=color=pink:amplitude=0.10:seed=41:sample_rate=48000:duration={DURATION},"
        "highpass=f=130,lowpass=f=1500,volume='0.32+0.10*sin(2*PI*t/4.7)':eval=frame[surf];"
        f"aevalsrc='{bells}':s=48000:d={DURATION},aecho=0.7:0.5:190:0.23[bells];"
        "[surf][bells]amix=inputs=2:normalize=0,volume=10,afade=t=in:d=0.7,"
        f"afade=t=out:st={DURATION - .8}:d=0.8,alimiter=limit=0.6:level=0[a]"
    )


def audit_encoded(final: Path, output: Path) -> dict:
    metadata = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format",
        "-of", "json", str(final),
    ]))
    stream = next(s for s in metadata["streams"] if s["codec_type"] == "video")
    assert (stream["width"], stream["height"]) == SIZE
    assert int(stream["nb_read_frames"]) == FPS * DURATION
    assert stream["r_frame_rate"] == f"{FPS}/1"
    assert abs(float(metadata["format"]["duration"]) - DURATION) < .05
    assert any(s["codec_type"] == "audio" for s in metadata["streams"])
    indices = [0, 36, 78, 135, 180, 234, 288, 315, FPS * DURATION - 1]
    sample_dir = output / "encoded-frames"
    sample_dir.mkdir(exist_ok=True)
    select = "+".join(f"eq(n\\,{index})" for index in indices)
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-i", str(final), "-vf", f"select={select}",
        "-fps_mode", "vfr", "-start_number", "0", str(sample_dir / "%02d.png"),
    ], check=True)
    sheet = Image.new("RGB", (1440, 3 * 292), "#111111")
    draw = ImageDraw.Draw(sheet)
    for index, frame_number in enumerate(indices):
        with Image.open(sample_dir / f"{index:02d}.png") as decoded:
            assert decoded.convert("L").getextrema()[1] > 180
            thumbnail = decoded.resize((480, 270), Image.Resampling.LANCZOS)
        x, y = (index % 3) * 480, (index // 3) * 292
        sheet.paste(thumbnail, (x, y))
        draw.text((x + 8, y + 273), f"{frame_number / FPS:.2f}s / frame {frame_number}", fill="white")
    sheet.save(output / "encoded-contact-sheet.jpg", quality=94)
    return {
        "frame_count": int(stream["nb_read_frames"]),
        "duration_seconds": float(metadata["format"]["duration"]),
        "sample_indices": indices,
        "sha256": hashlib.sha256(final.read_bytes()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        raise SystemExit("Output directory is not empty; choose a new cut directory")
    args.output.mkdir(parents=True, exist_ok=True)
    verify_geometry()
    source = Image.open(SOURCE).convert("RGB")
    raw_start = source_frame(source, 0).tobytes()
    raw_end = source_frame(source, (FPS * DURATION - 1) / FPS).tobytes()
    assert raw_start == raw_end
    silent = args.output / "crystal-lighthouse-picture.mp4"
    final = args.output / "openflipbook-lighthouse-demo-13s.mp4"
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required")
    process = subprocess.Popen([
        ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{SIZE[0]}x{SIZE[1]}", "-r", str(FPS), "-i", "pipe:0",
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(silent),
    ], stdin=subprocess.PIPE)
    try:
        assert process.stdin is not None
        for index in range(FPS * DURATION):
            process.stdin.write(film_frame(source, index / FPS).tobytes())
            if index % FPS == 0:
                print(f"Rendered {index // FPS}/{DURATION}s", flush=True)
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError("Picture encode failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    subprocess.run([
        ffmpeg, "-y", "-v", "error", "-i", str(silent), "-filter_complex", audio_filter(),
        "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac",
        "-b:a", "192k", "-ac", "2", "-t", str(DURATION), "-movflags", "+faststart", str(final),
    ], check=True)
    for time, name in ((0, "map"), (APPROACH_END, "close-up"), (DURATION, "return")):
        source_frame(source, time).save(args.output / f"{name}.png")
    film_frame(source, 5.3).save(args.output / "poster.jpg", quality=94)
    audit = Image.new("RGB", (1440, 1215))
    for i, time in enumerate((1.2, 2.7, 4.4, 6.1, 8, 10)):
        thumb = film_frame(source, time).resize((720, 405), Image.Resampling.LANCZOS)
        audit.paste(thumb, ((i % 2) * 720, (i // 2) * 405))
    audit.save(args.output / "contact-sheet.jpg", quality=94)
    receipt = {
        "source": str(SOURCE.relative_to(ROOT)),
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "file": final.name, "duration_seconds": DURATION, "size": SIZE, "fps": FPS,
        "landmark_bbox": LANDMARK, "tap": TAP, "crop": crop_for_landmark(),
        "full_landmark_visible_all_frames": True,
        "raw_start_return_equal": raw_start == raw_end,
        "raw_start_sha256": hashlib.sha256(raw_start).hexdigest(),
        "raw_return_sha256": hashlib.sha256(raw_end).hexdigest(),
        "encoded": audit_encoded(final, args.output),
        "timeline_seconds": {
            "map": [0, SELECT_START], "selection_cue": [SELECT_START, APPROACH_START],
            "approach": [APPROACH_START, APPROACH_END], "close_up": [APPROACH_END, RETURN_START],
            "return": [RETURN_START, RETURN_END], "unchanged_map": [RETURN_END, 10.8],
            "end_card": [10.8, DURATION],
        },
        "arrival": "Original source pixels only. No generated new viewpoint or interior.",
        "motion": "Uniform affine transform; hand-reviewed framing and film-specific timing, not a screen recording.",
        "selection": "Editorial tap cue at the fixture's actual target position, not a recorded UI event.",
        "identity_scope": "Underlying resampled source frames match exactly before titles and video compression. This film does not test persisted application state.",
        "audio": "Original procedural noise and synthesized bells; no third-party recordings.",
        "new_model_calls": 0, "new_model_cost_usd": 0,
    }
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(final)


if __name__ == "__main__":
    main()
