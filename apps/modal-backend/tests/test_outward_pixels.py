from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock

import pytest
from PIL import Image, ImageOps

from providers import image_edit
from providers.image import encode_data_url
from providers.outward_pixels import OutwardCanvas


def _bytes(image: Image.Image, fmt: str = "PNG", **kwargs: object) -> bytes:
    buf = io.BytesIO()
    image.save(buf, fmt, **kwargs)
    return buf.getvalue()


def _source() -> Image.Image:
    image = Image.new("RGBA", (31, 19))
    image.putdata([(x * 7 % 256, x * 13 % 256, x * 23 % 256, x % 256) for x in range(31 * 19)])
    return image


@pytest.mark.parametrize("factor", [1.5, 2.0, 3.0, 4.0])
def test_composite_preserves_every_source_pixel_and_the_generated_margin(factor: float) -> None:
    source = _source()
    layout = OutwardCanvas.prepare(_bytes(source), factor)
    margin = Image.new("RGB", layout.canvas_size, (9, 18, 27))
    result = Image.open(io.BytesIO(layout.composite(_bytes(margin))))
    x, y = layout.location
    crop = result.crop((x, y, x + source.width, y + source.height))
    assert crop.tobytes() == source.tobytes()
    assert result.getpixel((x - 1, y)) == (9, 18, 27, 255)
    assert result.getpixel((x + source.width, y)) == (9, 18, 27, 255)
    assert result.getpixel((x, y - 1)) == (9, 18, 27, 255)
    assert result.getpixel((x, y + source.height)) == (9, 18, 27, 255)
    assert result.format == "PNG"


def test_jpeg_is_decoded_once_without_lossy_reencoding_and_respects_orientation() -> None:
    source = _source().convert("RGB")
    exif = Image.Exif()
    exif[274] = 6
    data = _bytes(source, "JPEG", exif=exif)
    expected = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGBA")
    layout = OutwardCanvas.prepare(data, 2)
    assert layout.source_size == expected.size
    assert Image.open(io.BytesIO(layout.source_png)).tobytes() == expected.tobytes()


def test_wrong_canvas_dimensions_are_rejected_not_stretched() -> None:
    layout = OutwardCanvas.prepare(_bytes(_source()), 2)
    with pytest.raises(ValueError, match="wrong canvas dimensions"):
        layout.composite(_bytes(Image.new("RGB", (10, 10))))


@pytest.mark.parametrize("factor", [float("nan"), float("inf"), 1, 5])
def test_invalid_factor_is_rejected(factor: float) -> None:
    with pytest.raises(ValueError, match="zoom factor"):
        OutwardCanvas.prepare(_bytes(_source()), factor)


def test_oversized_canvas_fails_before_pixel_decode(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = MagicMock(width=2500, height=2500)
    monkeypatch.setattr(Image, "open", MagicMock(return_value=MagicMock(__enter__=lambda _: raw)))
    with pytest.raises(ValueError, match="too large"):
        OutwardCanvas.prepare(b"large-header", 2)
    raw.load.assert_not_called()


@pytest.mark.parametrize("wrong_size", [False, True])
async def test_provider_preserves_pixels_and_records_paid_output_before_compositing(
    monkeypatch: pytest.MonkeyPatch, wrong_size: bool,
) -> None:
    source = _source()
    data = _bytes(source)
    monkeypatch.setenv("MOCK_PROVIDERS", "0")
    monkeypatch.setenv("FAL_KEY", "test")
    upload = AsyncMock(return_value="fal://source")
    sub = AsyncMock(return_value={"image": {"url": "https://provider.test/out.png"}})
    monkeypatch.setattr(image_edit, "to_fal_url", upload)
    monkeypatch.setattr(image_edit, "_fal_subscribe", sub)
    size = (10, 10) if wrong_size else (62, 38)
    monkeypatch.setattr(image_edit, "_fetch_image_bytes", AsyncMock(return_value=(
        _bytes(Image.new("RGB", size, "red")), "image/png",
    )))
    billed = MagicMock()
    call = image_edit.expand_image_zoomout(
        encode_data_url(data, "image/png"), 2, preserve_source=True, on_generated=billed,
    )
    if wrong_size:
        with pytest.raises(ValueError, match="wrong canvas"):
            await call
    else:
        result = await call
        assert result.mime_type == "image/png"
        image = Image.open(io.BytesIO(result.jpeg_bytes))
        assert image.crop((15, 9, 46, 28)).tobytes() == source.tobytes()
    billed.assert_called_once()
    args = sub.await_args.args[1]
    assert args["canvas_size"] == [62, 38]
    assert args["original_image_location"] == [15, 9]


async def test_preservation_requires_inline_bytes_before_a_paid_call(monkeypatch: pytest.MonkeyPatch) -> None:
    sub = AsyncMock()
    monkeypatch.setattr(image_edit, "_fal_subscribe", sub)
    with pytest.raises(ValueError, match="inline source"):
        await image_edit.expand_image_zoomout("https://example.test/source.png", preserve_source=True)
    sub.assert_not_awaited()


async def test_mock_preservation_runs_real_composite_without_provider_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    sub = AsyncMock()
    monkeypatch.setattr(image_edit, "_fal_subscribe", sub)
    source = _source()
    result = await image_edit.expand_image_zoomout(
        encode_data_url(_bytes(source), "image/png"), 2, preserve_source=True,
    )
    image = Image.open(io.BytesIO(result.jpeg_bytes))
    assert image.size == (62, 38)
    assert image.crop((15, 9, 46, 28)).tobytes() == source.tobytes()
    sub.assert_not_awaited()
