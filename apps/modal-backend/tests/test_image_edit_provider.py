"""Tests for the edit/expand provider (providers/image_edit.py)."""
from __future__ import annotations

import base64
import struct
import zlib

import pytest

from providers import image_edit


def _png(w: int, h: int) -> bytes:
    """A minimal valid solid-colour PNG — enough for the header parser."""
    raw = (b"\x00" + b"\x7f\x40\x30" * w) * h

    def chunk(typ: bytes, data: bytes) -> bytes:
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(
            ">I", zlib.crc32(body) & 0xFFFFFFFF
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


# --- outpaint geometry --------------------------------------------------------


def test_expand_args_east_keeps_parent_left_and_grows_width() -> None:
    args = image_edit._expand_args_for("u", "east", 1600, 900)
    assert args["canvas_size"] == [2400, 900]  # +50% width
    assert args["original_image_location"] == [0, 0]  # parent at the left, new on right
    assert args["original_image_size"] == [1600, 900]


def test_expand_args_west_shifts_parent_right() -> None:
    args = image_edit._expand_args_for("u", "west", 1600, 900)
    assert args["canvas_size"] == [2400, 900]
    assert args["original_image_location"] == [800, 0]  # parent right, new on left


def test_expand_args_north_south_grow_height() -> None:
    south = image_edit._expand_args_for("u", "south", 1600, 900)
    assert south["canvas_size"] == [1600, 1350]
    assert south["original_image_location"] == [0, 0]
    north = image_edit._expand_args_for("u", "north", 1600, 900)
    assert north["original_image_location"] == [0, 450]  # parent bottom, new above


# --- OUTWARD zoom-out geometry (centered, not edge-pinned) --------------------


def test_zoomout_args_center_the_source() -> None:
    args = image_edit._zoomout_args_for("u", 3.0, 100, 60)
    assert args["canvas_size"] == [300, 180]
    assert args["original_image_size"] == [100, 60]
    # Equal margin on every side → the source is the central sub-region.
    assert args["original_image_location"] == [100, 60]
    left = args["original_image_location"][0]
    right = args["canvas_size"][0] - left - args["original_image_size"][0]
    assert left == right


def test_zoomout_factor_clamped_per_hop() -> None:
    assert image_edit._clamp_zoom_factor(10.0) == 4.0  # capped
    assert image_edit._clamp_zoom_factor(1.1) == 1.5  # floored
    assert image_edit._clamp_zoom_factor(3.0) == 3.0  # in range


# --- dimension probing (Pillow-free) ------------------------------------------


def test_img_dims_reads_png_header() -> None:
    assert image_edit._img_dims(_png(256, 144)) == (256, 144)


def test_dims_from_data_url_round_trips_png() -> None:
    data_url = "data:image/png;base64," + base64.b64encode(_png(320, 180)).decode()
    assert image_edit._dims_from_data_url(data_url) == (320, 180)


def test_dims_from_data_url_returns_none_for_http_or_junk() -> None:
    assert image_edit._dims_from_data_url("https://cdn/x.png") is None
    assert image_edit._dims_from_data_url("data:image/png;base64,@@@") is None


# --- response normalisation ---------------------------------------------------


def test_expand_first_image_accepts_bria_singular() -> None:
    info = image_edit._expand_first_image({"image": {"url": "u"}, "seed": 1})
    assert info == {"url": "u"}


def test_expand_first_image_falls_back_to_plural() -> None:
    info = image_edit._expand_first_image({"images": [{"url": "v"}]})
    assert info == {"url": "v"}


# --- end-to-end (mocked fal) --------------------------------------------------


async def test_expand_image_parses_bria_and_uses_real_dims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    async def fake_to_fal(data_url: str) -> str:
        return "fal://parent"

    async def fake_sub(model: str, args: dict) -> dict:
        captured["model"] = model
        captured["args"] = args
        # BRIA Expand's real shape: a singular `image`, not `images: [...]`.
        return {"image": {"url": "http://x", "content_type": "image/png"}, "seed": 9}

    async def fake_fetch(info: dict) -> tuple[bytes, str]:
        captured["fetched"] = info
        return b"jpeg", "image/png"

    monkeypatch.setenv("FAL_KEY", "fk")
    monkeypatch.setattr(image_edit, "to_fal_url", fake_to_fal)
    monkeypatch.setattr(image_edit, "_fal_subscribe", fake_sub)
    monkeypatch.setattr(image_edit, "_fetch_image_bytes", fake_fetch)

    # A real 1024x576 PNG parent — expand_image should measure it, not trust the
    # 1600x900 default, so the canvas grows from the true width.
    data_url = "data:image/png;base64," + base64.b64encode(_png(1024, 576)).decode()
    out = await image_edit.expand_image(data_url, "east")

    assert out.jpeg_bytes == b"jpeg"
    assert "bria" in captured["model"]
    assert captured["args"]["original_image_size"] == [1024, 576]
    assert captured["args"]["canvas_size"] == [1536, 576]  # +50% of measured width
    assert captured["fetched"] == {"url": "http://x", "content_type": "image/png"}


async def test_expand_image_zoomout_centers_and_uses_real_dims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    async def fake_to_fal(data_url: str) -> str:
        return "fal://parent"

    async def fake_sub(model: str, args: dict) -> dict:
        captured["model"] = model
        captured["args"] = args
        return {"image": {"url": "http://x", "content_type": "image/png"}}

    async def fake_fetch(info: dict) -> tuple[bytes, str]:
        return b"jpeg", "image/png"

    monkeypatch.setenv("FAL_KEY", "fk")
    monkeypatch.setattr(image_edit, "to_fal_url", fake_to_fal)
    monkeypatch.setattr(image_edit, "_fal_subscribe", fake_sub)
    monkeypatch.setattr(image_edit, "_fetch_image_bytes", fake_fetch)

    data_url = "data:image/png;base64," + base64.b64encode(_png(1024, 576)).decode()
    # factor 10 is clamped to 4x per hop; the parent is centered on the canvas.
    out = await image_edit.expand_image_zoomout(data_url, factor=10.0)

    assert out.jpeg_bytes == b"jpeg"
    assert "bria" in captured["model"]
    assert captured["args"]["original_image_size"] == [1024, 576]
    assert captured["args"]["canvas_size"] == [4096, 2304]  # 4x clamp of measured dims
    assert captured["args"]["original_image_location"] == [1536, 864]  # centered
