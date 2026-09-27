"""Frozen source-pixel controls, without providers or network access."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

from .runner import BACKEND, atomic_json

SOURCE = BACKEND / "tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg"
LANDMARK = (0.082, 0.074, 0.127, 0.438)
TAP = (0.138, 0.312)
PADDING = 0.045
SIZE = (1280, 704)
FAST_SIZE = (1920, 1080)
FRAMES = 121
FPS = 24
VERSION = "lighthouse-affine-canny-v1"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def crop() -> tuple[float, float, float]:
    x, y, w, h = LANDMARK
    fraction = max(0.42, w + 2 * PADDING, h + 2 * PADDING)
    origins = []
    for point, low, length in ((TAP[0], x, w), (TAP[1], y, h)):
        lower = max(0, low + length + PADDING - fraction)
        upper = min(1 - fraction, low - PADDING)
        origins.append(min(upper, max(lower, point - fraction / 2)))
    return *origins, fraction


def transform(progress: float) -> tuple[float, float, float]:
    x, y, fraction = crop()
    t = min(1, max(0, progress))
    ease = t * t * (3 - 2 * t)
    return 1 + (1 / fraction - 1) * ease, -x / fraction * ease, -y / fraction * ease


def expected_box(progress: float) -> list[float]:
    scale, tx, ty = transform(progress)
    x, y, w, h = LANDMARK
    return [scale * x + tx, scale * y + ty, scale * w, scale * h]


def contain(size: tuple[int, int], source_size: tuple[int, int]) -> list[int]:
    fit = min(size[0] / source_size[0], size[1] / source_size[1])
    w, h = (round(v * fit) for v in source_size)
    return [(size[0] - w) // 2, (size[1] - h) // 2, w, h]


def frame(source: Image.Image, progress: float, size: tuple[int, int] = SIZE) -> Image.Image:
    scale, tx, ty = transform(progress)
    region = (
        -tx / scale * source.width,
        -ty / scale * source.height,
        (1 - tx) / scale * source.width,
        (1 - ty) / scale * source.height,
    )
    x, y, w, h = contain(size, source.size)
    pixels = source.transform((w, h), Image.Transform.EXTENT, region, Image.Resampling.BICUBIC)
    result = Image.new("RGB", size, "#111111")
    result.paste(pixels, (x, y))
    return result


def encode_reference(source: Image.Image, output: Path) -> None:
    process = subprocess.Popen(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{SIZE[0]}x{SIZE[1]}",
            "-r",
            str(FPS),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ],
        stdin=subprocess.PIPE,
    )
    try:
        for index in range(FRAMES):
            process.stdin.write(frame(source, index / (FRAMES - 1)).tobytes())
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError("Reference encode failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def prepare(directory: Path) -> dict:
    signature = {
        "version": VERSION,
        "source_sha256": sha(SOURCE),
        "landmark": list(LANDMARK),
        "tap": list(TAP),
        "padding": PADDING,
        "crop": list(crop()),
        "size": list(SIZE),
        "frames": FRAMES,
        "fps": FPS,
    }
    path = directory / "manifest.json"
    if path.exists():
        previous = json.loads(path.read_text())
        if previous["signature"] != signature:
            raise ValueError("Frozen input manifest changed; use a separately authorized study")
        for name, digest in previous["assets"].items():
            if sha(directory / name) != digest:
                raise ValueError(f"Input changed: {name}")
        return previous
    directory.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE).convert("RGB")
    for name, progress in (("first", 0), ("middle", 0.5), ("last", 1)):
        frame(source, progress).save(directory / f"{name}.png")
    for name, progress in (("fast-first", 0), ("fast-last", 1)):
        frame(source, progress, FAST_SIZE).save(directory / f"{name}.png")
    encode_reference(source, directory / "reference.mp4")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(directory / "reference.mp4"),
            "-vf",
            "edgedetect=mode=wires:low=0.1:high=0.4",
            "-an",
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-pix_fmt",
            "yuv420p",
            str(directory / "edges.mp4"),
        ],
        check=True,
    )
    files = (
        "first.png",
        "middle.png",
        "last.png",
        "fast-first.png",
        "fast-last.png",
        "reference.mp4",
        "edges.mp4",
    )
    manifest = {
        "signature": signature,
        "assets": {name: sha(directory / name) for name in files},
        "source_size": list(source.size),
        "content_rect": contain(SIZE, source.size),
        "fast_content_rect": contain(FAST_SIZE, source.size),
        "expected_boxes": [expected_box(i / 10) for i in range(11)],
    }
    atomic_json(path, manifest)
    return manifest


def inspect_video(path: Path) -> dict:
    raw = json.loads(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-count_frames",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ]
        )
    )
    stream = next(s for s in raw["streams"] if s["codec_type"] == "video")
    count = int(stream["nb_read_frames"])
    indices = [round(i * (count - 1) / 10) for i in range(11)]
    selected = "+".join(f"eq(n\\,{n})" for n in indices)
    sample_dir = path.parent / f"{path.stem}-frames"
    sample_dir.mkdir(exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            f"select={selected}",
            "-fps_mode",
            "vfr",
            "-start_number",
            "0",
            str(sample_dir / "%02d.png"),
        ],
        check=True,
    )
    sheet = Image.new("RGB", (1280, 6 * 210), "#111111")
    draw = ImageDraw.Draw(sheet)
    for i in range(11):
        sample = Image.open(sample_dir / f"{i:02d}.png").convert("RGB")
        sample.thumbnail((640, 185))
        x, y = (i % 2) * 640, (i // 2) * 210
        sheet.paste(sample, (x + (640 - sample.width) // 2, y))
        draw.text((x + 8, y + 188), f"{i * 10}% / decoded frame {indices[i]}", fill="white")
    sheet.save(path.with_name(f"{path.stem}-contact.jpg"), quality=92)
    return {
        "width": stream["width"],
        "height": stream["height"],
        "frame_count": count,
        "fps": stream["r_frame_rate"],
        "duration_seconds": float(raw["format"]["duration"]),
        "sample_indices": indices,
        "sha256": sha(path),
    }
