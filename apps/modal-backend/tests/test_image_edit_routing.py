from unittest.mock import AsyncMock

import pytest

from providers import image_edit as edit


def test_pro_edit_default_and_legacy_pins_use_reference_endpoint(monkeypatch):
    monkeypatch.delenv("FAL_EDIT_MODEL_BALANCED", raising=False)
    assert edit._resolve_edit_model("balanced", None) == "fal-ai/nano-banana-pro/edit"
    assert edit._resolve_edit_model(None, "fal-ai/nano-banana-pro") == "fal-ai/nano-banana-pro/edit"
    monkeypatch.setenv("FAL_EDIT_MODEL_BALANCED", "fal-ai/nano-banana-pro")
    assert edit._resolve_edit_model("balanced", None).endswith("/edit")
    assert edit._resolve_edit_model(None, "fal-ai/flux-pro/kontext") == "fal-ai/flux-pro/kontext"


@pytest.mark.parametrize("operation", ["edit", "continue"])
async def test_actual_submission_retains_references_and_reports_effective_model(monkeypatch, operation):
    from providers import mock

    monkeypatch.setattr(mock, "on", lambda: False)
    monkeypatch.setattr(edit, "_ensure_fal_key", lambda: None)
    monkeypatch.setattr(edit, "to_fal_url", AsyncMock(side_effect=lambda url: url))
    submit = AsyncMock(return_value={"images": [{"url": "https://example.test/image.png"}]})
    monkeypatch.setattr(edit, "_fal_subscribe", submit)
    monkeypatch.setattr(edit, "_fetch_image_bytes", AsyncMock(return_value=(b"pixels", "image/png")))
    call = edit.edit_image if operation == "edit" else edit.continue_image
    result = await call("https://example.test/source.png", "Enter the shop", model_override="fal-ai/nano-banana-pro")
    assert submit.await_args.args[0] == "fal-ai/nano-banana-pro/edit"
    assert submit.await_args.args[1]["image_urls"] == ["https://example.test/source.png"]
    assert result.model == "fal-ai/nano-banana-pro/edit"


@pytest.mark.parametrize("model", ["fal-ai/nano-banana-pro", "fal-ai/nano-banana-pro/edit", "fal-ai/nano-banana/edit"])
async def test_edit_forwards_explicit_aspect_without_changing_reference_order(monkeypatch, model):
    from providers import mock
    monkeypatch.setattr(mock, "on", lambda: False)
    monkeypatch.setattr(edit, "_ensure_fal_key", lambda: None)
    monkeypatch.setattr(edit, "to_fal_url", AsyncMock(side_effect=lambda url: url))
    submit = AsyncMock(return_value={"images": [{"url": "out"}]})
    monkeypatch.setattr(edit, "_fal_subscribe", submit)
    monkeypatch.setattr(edit, "_fetch_image_bytes", AsyncMock(return_value=(b"pixels", "image/png")))
    assert edit.supports_aspect_ratio(model)
    await edit.edit_image("world", "arrive", model_override=model, identity_ref_url="crop", aspect_ratio="16:9")
    assert submit.await_args.args[1] == {"prompt": "arrive", "image_urls": ["world", "crop"], "aspect_ratio": "16:9"}


@pytest.mark.parametrize("model,aspect", [("fal-ai/nano-banana-pro/edit", "typo"), ("fal-ai/flux-pro/kontext", "16:9")])
async def test_invalid_or_unsupported_aspect_fails_before_upload(monkeypatch, model, aspect):
    upload = AsyncMock()
    monkeypatch.setattr(edit, "to_fal_url", upload)
    with pytest.raises(ValueError, match="aspect ratio"):
        await edit.edit_image("source", "prompt", model_override=model, aspect_ratio=aspect)
    upload.assert_not_awaited()


async def test_layout_reference_rides_last_and_only_on_multi_image_models(monkeypatch):
    from providers import mock
    monkeypatch.setattr(mock, "on", lambda: False)
    monkeypatch.setattr(edit, "_ensure_fal_key", lambda: None)
    monkeypatch.setattr(edit, "to_fal_url", AsyncMock(side_effect=lambda url: url))
    submit = AsyncMock(return_value={"images": [{"url": "out"}]})
    monkeypatch.setattr(edit, "_fal_subscribe", submit)
    monkeypatch.setattr(edit, "_fetch_image_bytes", AsyncMock(return_value=(b"pixels", "image/png")))
    await edit.edit_image(
        "world", "arrive", model_override="fal-ai/nano-banana-pro/edit",
        style_ref_url="style", identity_ref_url="crop", layout_ref_url="blocks",
    )
    assert submit.await_args.args[1]["image_urls"][-1] == "blocks"
    assert submit.await_args.args[1]["image_urls"][0] == "world"
    await edit.edit_image("world", "arrive", model_override="fal-ai/flux-pro/kontext", layout_ref_url="blocks")
    assert "blocks" not in str(submit.await_args.args[1])


def test_layout_sentence_names_the_colours():
    text = edit.layout_reference_sentence([("red", "The Copper Kettle"), ("blue", "Ropewalk Store"), ("", "skip")])
    assert "LAST reference image" in text
    assert "(red = The Copper Kettle; blue = Ropewalk Store)" in text
    assert "never flat coloured boxes" in text
    assert "(" not in edit.layout_reference_sentence([])
