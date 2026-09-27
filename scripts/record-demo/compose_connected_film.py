#!/usr/bin/env python3
"""Offline editorial cut of reviewed saved views, never a simulated 3D journey."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / "apps/modal-backend/tests/continuity_bench/reports/connected-demo"
SIZE, FPS, DURATION = (1920, 1080), 30, 27
# Only uniform reframing of an existing parent image, followed by a hard cut.
# The lighthouse gets editorial headroom around the reviewed crystal bounds.
EDGES = {"market": ("root", (.656, .354), .42),
         "interior": ("market", (.912, .702), 1 / 1.35),
         "lighthouse": ("root", (.139, .293), .528)}
# start, end, child, reverse. The 0.1s hold before each arrival is deliberate.
MOVES = [(1.5, 2.4, "market", False), (5.2, 5.75, "interior", False),
         (9.0, 9.55, "interior", True), (10.8, 11.7, "market", True),
         (13.0, 13.9, "lighthouse", False), (17.3, 18.2, "lighthouse", True),
         (19.6, 20.5, "market", False), (22.5, 23.4, "market", True)]
STILLS = [(0, 1.5, "root"), (2.4, 5.2, "market"), (5.75, 9, "interior"),
          (9.55, 10.8, "market"), (11.7, 13, "root"), (13.9, 17.3, "lighthouse"),
          (18.2, 19.6, "root"), (20.5, 22.5, "market"), (23.4, 27, "root")]
CUES = [(1.1, 1.5, "market"), (4.8, 5.2, "interior"),
        (12.6, 13, "lighthouse"), (19.2, 19.6, "market")]
TITLES = [(0, 1.1, "openflipbook", "Aethelgard Harbor"),
          (2.5, 4.7, "Quayside Market", ""),
          (5.9, 8.8, "Quayside Provisions", "Inside the shop."),
          (9.6, 10.7, "Quayside Market", "Back outside."),
          (14, 17.1, "Crystal Lighthouse", ""),
          (20.6, 22.4, "Quayside Market", "The saved view, again."),
          (23.7, 27.3, "openflipbook", "A world you can return to.")]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def smooth(t: float) -> float:
    t = min(1, max(0, t))
    return t * t * (3 - 2 * t)


def crop(child: str) -> tuple[float, float, float]:
    _, point, fraction = EDGES[child]
    return (max(0, min(1 - fraction, point[0] - fraction / 2)),
            max(0, min(1 - fraction, point[1] - fraction / 2)), fraction)


def state(time: float) -> tuple[str, float, float, float]:
    for start, end, child, reverse in MOVES:
        if start <= time < end:
            duration = end - start - .1
            progress = smooth((time - start) / duration)
            if reverse:
                progress = 1 - progress
            x, y, fraction = crop(child)
            scale = 1 + (1 / fraction - 1) * progress
            return EDGES[child][0], scale, -x / fraction * progress, -y / fraction * progress
    for start, end, node in STILLS:
        if start <= time < end:
            return node, 1, 0, 0
    raise ValueError(f"Time outside film: {time}")


def source_frame(source: Image.Image, transform: tuple[float, float, float]) -> Image.Image:
    scale, tx, ty = transform
    fit = min(SIZE[0] / source.width, SIZE[1] / source.height)
    width, height = round(source.width * fit), round(source.height * fit)
    region = (-tx / scale * source.width, -ty / scale * source.height,
              (1 - tx) / scale * source.width, (1 - ty) / scale * source.height)
    pixels = source.transform((width, height), Image.Transform.EXTENT, region, Image.Resampling.BICUBIC)
    frame = Image.new("RGB", SIZE, "#101719")
    frame.paste(pixels, ((SIZE[0] - width) // 2, (SIZE[1] - height) // 2))
    return frame


@lru_cache
def font(size: int, bold: bool = False):
    return ImageFont.truetype(f"/System/Library/Fonts/Supplemental/Arial{' Bold' if bold else ''}.ttf", size)


def frame_at(images: dict[str, Image.Image], time: float, overlays: bool = True) -> Image.Image:
    node, *transform = state(time)
    frame = source_frame(images[node], tuple(transform))
    if not overlays:
        return frame
    layer = Image.new("RGBA", SIZE)
    draw = ImageDraw.Draw(layer)
    for start, end, heading, subtitle in TITLES:
        if start <= time < end:
            alpha = min(smooth((time - start + (.2 if start == 0 else 0)) / .2), smooth((end - time) / .2))
            for y in range(820, SIZE[1]):
                draw.line((0, y, SIZE[0], y), fill=(8, 15, 18, round(180 * alpha * (y - 820) / 260)))
            draw.text((64, 930 if not subtitle else 910), heading, font=font(46, True), fill=(255, 255, 255, round(255 * alpha)))
            if subtitle:
                draw.text((66, 974), subtitle, font=font(26), fill=(239, 245, 245, round(255 * alpha)))
    for start, end, child in CUES:
        if start <= time < end:
            source = images[node]
            fit = min(SIZE[0] / source.width, SIZE[1] / source.height)
            width, height = round(source.width * fit), round(source.height * fit)
            point = EDGES[child][1]
            x, y = (SIZE[0] - width) / 2 + point[0] * width, (SIZE[1] - height) / 2 + point[1] * height
            radius = 18 + 20 * smooth((time - start) / (end - start))
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=(12, 20, 24, 200), width=7)
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline="white", width=3)
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill="white")
    return Image.alpha_composite(frame.convert("RGBA"), layer).convert("RGB")


def load_images() -> tuple[dict, dict]:
    manifest = json.loads((REPORTS / "local-world.json").read_text())
    images = {}
    for name, row in manifest["nodes"].items():
        source = Path(row["source_path"])
        if sha(source) != row["sha256"]:
            raise ValueError("Saved source bytes changed")
        if row["shot"]:
            receipt = json.loads((REPORTS / f"{row['shot']}-receipt.json").read_text())
            if receipt["review"]["accepted"] is not True or receipt["output_sha256"] != row["sha256"]:
                raise ValueError("A film arrival must be reviewed against these exact pixels")
        with Image.open(source) as image:
            images[name] = image.convert("RGB")
    return manifest, images


def audio_filter() -> str:
    # Original synthetic ambience and soft arrival chimes; no licensed samples.
    pulses = []
    for start, frequency in [(2.4, 392), (5.75, 493.88), (13.9, 587.33), (20.5, 392)]:
        t = f"(t-{start})"
        pulses.append(f"if(gte(t,{start}),.03*exp(-2.6*{t})*(1-exp(-50*{t}))*sin(2*PI*{frequency}*{t}),0)")
    return (f"anoisesrc=color=pink:amplitude=.035:seed=79:sample_rate=48000:duration={DURATION},"
            "highpass=f=150,lowpass=f=1400,volume=.5[air];"
            f"aevalsrc='{'+'.join(pulses)}':s=48000:d={DURATION},aecho=.7:.5:160:.2[notes];"
            "[air][notes]amix=inputs=2:normalize=0,volume=6,afade=t=in:d=0.5,"
            f"afade=t=out:st={DURATION - 1}:d=1,alimiter=limit=.6:level=0[a]")


def audit(final: Path, output: Path) -> dict:
    metadata = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(final)]))
    video = next(s for s in metadata["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == SIZE and int(video["nb_read_frames"]) == FPS * DURATION
    assert video["r_frame_rate"] == f"{FPS}/1" and abs(float(metadata["format"]["duration"]) - DURATION) < .05
    assert any(s["codec_type"] == "audio" for s in metadata["streams"])
    times = [.5, 2.2, 3.4, 5.6, 7.2, 10.1, 12, 13.7, 15.5, 18.8, 21.5, 25.4]
    samples = output / "encoded-frames"
    samples.mkdir(exist_ok=True)
    select = "+".join(f"eq(n\\,{round(t * FPS)})" for t in times)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(final), "-vf", f"select={select}", "-fps_mode", "vfr", "-start_number", "0", str(samples / "%02d.png")], check=True)
    sheet = Image.new("RGB", (1440, 4 * 292), "#101719")
    draw = ImageDraw.Draw(sheet)
    for i, t in enumerate(times):
        with Image.open(samples / f"{i:02d}.png") as decoded:
            assert decoded.convert("L").getextrema()[1] > 180
            thumb = decoded.resize((480, 270), Image.Resampling.LANCZOS)
        x, y = (i % 3) * 480, (i // 3) * 292
        sheet.paste(thumb, (x, y))
        draw.text((x + 8, y + 272), f"{t:.1f}s", fill="white")
    sheet.save(output / "contact-sheet.jpg", quality=95)
    return {"frames": FPS * DURATION, "duration": DURATION, "sha256": sha(final), "sample_times": times}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        raise SystemExit("Choose an empty output folder; existing cuts are preserved")
    manifest, images = load_images()
    args.output.mkdir(parents=True, exist_ok=True)
    start = frame_at(images, 0, False).tobytes()
    assert start == frame_at(images, 26, False).tobytes()
    final = args.output / "openflipbook-connected-journey-27s.mp4"
    process = subprocess.Popen(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "1920x1080", "-r", str(FPS), "-i", "pipe:0",
        "-filter_complex", audio_filter(), "-map", "0:v", "-map", "[a]", "-t", str(DURATION),
        "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(final)], stdin=subprocess.PIPE)
    try:
        for i in range(FPS * DURATION):
            process.stdin.write(frame_at(images, i / FPS).tobytes())
            if i % (FPS * 3) == 0:
                print(f"Rendered {i // FPS}/{DURATION}s", flush=True)
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError("Film encoder failed")
    except BaseException:
        process.kill()
        process.wait()
        raise
    receipt = {"kind": "editorial-film-from-saved-assets", "not_screen_recording": True,
        "new_video_generation": False, "curated_still_arrivals": True, "geometry_verified": False,
        "raw_map_return_equal": True, "navigation": manifest, "moves": MOVES, "encoded": audit(final, args.output)}
    (args.output / "film-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(final, flush=True)


if __name__ == "__main__":
    main()
