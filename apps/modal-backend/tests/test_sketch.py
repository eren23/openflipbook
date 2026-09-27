import base64
import io
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from providers import sketch


def picture(color="red", size=(1024, 1024)):
    return Image.new("RGBA", size, color)


def inputs(**changes):
    return sketch.SketchInput(
        kind="edit",
        width=1024,
        height=1024,
        guide=sketch.data_url(picture()),
        mask=sketch.data_url(picture("white")),
        **changes,
    )


def test_compositor_preserves_every_channel_outside_mask():
    source = picture((12, 44, 76, 93), (64, 32))
    mask = picture("black", source.size)
    mask.paste("white", (10, 8, 31, 25))
    result = sketch.composite(source, picture("blue", source.size), mask)
    for y in range(32):
        for x in range(64):
            assert result.getpixel((x, y)) == (
                (0, 0, 255, 255) if 10 <= x < 31 and 8 <= y < 25 else source.getpixel((x, y))
            )
    assert Image.open(io.BytesIO(sketch.png(result))).tobytes() == result.tobytes()


def test_empty_and_misaligned_masks_fail_closed():
    with pytest.raises(ValueError, match="Select"):
        sketch.composite(picture(), picture(), picture("black"))
    with pytest.raises(ValueError, match="dimensions"):
        sketch.composite(picture(), picture(), picture(size=(80, 80)))


def test_focused_bounds_include_context_and_clamp_to_image():
    mask = picture("black", (1600, 900))
    mask.paste("white", (700, 500, 780, 550))
    assert sketch.focused_bounds(mask) == (640, 440, 840, 610)
    mask = picture("black", (100, 80))
    mask.paste("white", (0, 0, 10, 10))
    assert sketch.focused_bounds(mask) == (0, 0, 42, 42)
    with pytest.raises(ValueError):
        sketch.focused_bounds(picture("black"))


@pytest.mark.asyncio
async def test_focused_repaint_returns_full_frame_and_protects_every_outside_pixel(monkeypatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    source = picture((12, 44, 76, 93), (1600, 900))
    guide = picture("yellow", source.size)
    mask = picture("black", source.size)
    mask.paste("white", (700, 500, 760, 540))
    data = sketch.SketchInput(kind="edit", width=1600, height=900, guide=sketch.data_url(guide), mask=sketch.data_url(mask), focus_region=True)
    result, outside = await sketch.render_sketch(data, sketch.data_url(source), "Map edit", "fal-ai/nano-banana-pro/edit", "test")
    output = Image.open(io.BytesIO(result.jpeg_bytes))
    assert output.size == source.size and outside == 0
    expected = source.copy()
    expected.paste("yellow", (700, 500, 760, 540))
    assert output.tobytes() == expected.tobytes()
    with pytest.raises(ValueError, match="Focused editing"):
        await sketch.render_sketch(data.model_copy(update={"scope": "whole"}), sketch.data_url(source), "", "fal-ai/nano-banana-pro/edit", "test")


@pytest.mark.parametrize("output", ["object", "environment", "artwork"])
def test_finished_output_intents_preserve_user_instructions(output):
    data = inputs(output=output)
    prompt = sketch.workflow_prompt(data, False, "Keep my lettering ABC")
    assert "finished" in prompt
    assert prompt.endswith("Keep my lettering ABC")


@pytest.mark.parametrize("material", ["custom", "ceramic", "metal", "fabric", "wood", "glass"])
def test_material_prompt_preserves_design_and_camera(material):
    prompt = sketch.workflow_prompt(
        inputs(workflow="material", material=material), True, "Red trim"
    )
    assert "surface appearance only" in prompt
    assert "preserve silhouette" in prompt
    assert "Preserve the original camera" in prompt
    assert prompt.endswith("Red trim")


def test_viewpoint_prompt_explicitly_allows_camera_change():
    prompt = sketch.workflow_prompt(
        inputs(workflow="viewpoint", viewpoint="eye_level"), True, "Garden"
    )
    assert "Propose a eye-level view" in prompt
    assert "Preserve the original camera" not in prompt
    assert "Infer hidden surfaces conservatively" in prompt


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes,source",
    [
        ({"workflow": "placement"}, True),
        ({"workflow": "placement", "subject": "x", "scope": "whole"}, True),
        ({"workflow": "placement", "subject": "x"}, False),
        ({"workflow": "viewpoint"}, True),
        ({"workflow": "viewpoint", "scope": "whole"}, False),
    ],
)
async def test_workflow_prerequisites_fail_before_provider(monkeypatch, changes, source):
    submit = AsyncMock()
    monkeypatch.setattr(sketch.images, "_fal_subscribe", submit)
    with pytest.raises(ValueError, match=r"requires|require"):
        await sketch.render_sketch(
            inputs().model_copy(update=changes),
            sketch.data_url(picture()) if source else None,
            "",
            sorted(sketch.MODELS)[0],
            "test",
        )
    submit.assert_not_called()


@pytest.mark.parametrize(
    "size", [(1024, 1024), (999, 711), (160, 200), (1920, 1080), (1080, 1920), (4096, 1024)]
)
def test_working_frame_is_supported_and_never_crops(size):
    resized, padded = sketch.working_frame(size)
    assert all(n % 16 == 0 for n in padded)
    assert 655_360 <= padded[0] * padded[1] <= 8_294_400
    assert padded[0] >= resized[0] and padded[1] >= resized[1]
    assert max(padded) / min(padded) <= 3


@pytest.mark.parametrize(
    "value",
    [
        "https://example.test/image.png",
        "data:image/svg+xml;base64,YQ==",
        "data:image/png;base64,!!!",
    ],
)
def test_rejects_non_raster_or_invalid_sources(value):
    with pytest.raises((ValueError, TypeError)):
        sketch.decode(value)


@pytest.mark.asyncio
async def test_validation_precedes_any_provider_submission(monkeypatch):
    submit = AsyncMock()
    monkeypatch.setattr(sketch.images, "_fal_subscribe", submit)
    for changed, match in [
        ({"mask": None}, "region"),
        ({"width": 800}, "dimensions"),
        ({"mask": sketch.data_url(picture("black"))}, "region"),
    ]:
        data = inputs().model_copy(update=changed)
        with pytest.raises(ValueError, match=match):
            await sketch.render_sketch(
                data,
                sketch.data_url(picture()),
                "Red roof",
                "openai/gpt-image-2.5/flare/edit",
                "test",
            )
    submit.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("model", sorted(sketch.MODELS))
@pytest.mark.parametrize("workflow", ["render", "placement"])
async def test_provider_reference_order_mask_conversion_and_single_attempt(
    monkeypatch, model, workflow
):
    monkeypatch.setenv("MOCK_PROVIDERS", "0")
    monkeypatch.setattr(sketch.images, "_ensure_fal_key", lambda: None)
    monkeypatch.setattr(sketch, "to_fal_url", AsyncMock(side_effect=lambda value: value))
    submit = AsyncMock(return_value={"images": [{"url": "result"}], "requestId": "receipt"})
    monkeypatch.setattr(sketch.images, "_fal_subscribe", submit)
    monkeypatch.setattr(
        sketch.images,
        "_fetch_image_bytes",
        AsyncMock(return_value=(sketch.png(picture("yellow")), "image/png")),
    )
    source = picture("blue")
    region = picture("black")
    region.paste("white", (100, 100, 300, 300))
    inp = inputs(
        style=sketch.data_url(picture("green")),
        workflow=workflow,
        subject=sketch.data_url(picture("purple")) if workflow == "placement" else None,
    ).model_copy(update={"mask": sketch.data_url(region)})
    result, outside = await sketch.render_sketch(
        inp, sketch.data_url(source), "Red roof", model, "test"
    )
    args = submit.call_args.args[1]
    assert len(args["image_urls"]) == (4 if workflow == "placement" else 3)
    if workflow == "placement":
        assert "Image 3 is the OBJECT REFERENCE" in args["prompt"]
        assert sketch.decode(args["image_urls"][2]).getpixel((0, 0)) == (128, 0, 128, 255)
    assert sketch.decode(args["image_urls"][-1]).getpixel((0, 0)) == (0, 128, 0, 255)
    assert sketch.decode(args["image_urls"][0]).getpixel((0, 0)) == (0, 0, 255, 255)
    assert sketch.decode(args["image_urls"][1]).getpixel((0, 0)) == (255, 0, 0, 255)
    assert "instructions, not artwork" in args["prompt"]
    assert submit.call_args.kwargs["budget"].limit == 1
    if model.startswith("openai/"):
        native = Image.open(io.BytesIO(base64.b64decode(args["mask_url"].split(",", 1)[1])))
        assert native.getpixel((150, 150))[3] == 0
        assert native.getpixel((0, 0))[3] == 255
        assert args["quality"] == "high"
    else:
        assert "mask_url" not in args
    assert outside == 0
    assert result.mime_type == "image/png" and result.provider_request_id == "receipt"
    final = Image.open(io.BytesIO(result.jpeg_bytes))
    assert final.getpixel((0, 0)) == (0, 0, 255, 255)
    assert final.getpixel((150, 150)) == (255, 255, 0, 255)


@pytest.mark.asyncio
async def test_creation_and_whole_image_mock_do_not_claim_protection(monkeypatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    for kind, source in [("create", None), ("edit", sketch.data_url(picture("blue")))]:
        inp = inputs().model_copy(update={"kind": kind, "scope": "whole", "mask": None})
        result, outside = await sketch.render_sketch(
            inp, source, "A castle", "openai/gpt-image-2.5/flare/edit", "test"
        )
        assert outside is None
        assert result.provider_request_id == "mock-sketch"


@pytest.mark.asyncio
async def test_rejects_unknown_provider_and_missing_source():
    with pytest.raises(ValueError, match="model"):
        await sketch.render_sketch(inputs(), None, "", "unknown", "test")
    with pytest.raises(ValueError, match="Source"):
        await sketch.render_sketch(inputs(), None, "", "openai/gpt-image-2.5/flare/edit", "test")
