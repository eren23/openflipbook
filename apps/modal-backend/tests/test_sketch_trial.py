import json
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from providers.image import GeneratedImage
from providers.sketch import decode, png
from tests import sketch_trial


@pytest.mark.asyncio
async def test_placement_trial_preserves_roles_mask_and_refuses_rebilling(tmp_path, monkeypatch):
    source = tmp_path / "desk.png"
    subject = tmp_path / "lamp.png"
    Image.new("RGB", (1024, 1024), "white").save(source)
    Image.new("RGB", (1024, 1024), "green").save(subject)
    output = tmp_path / "receipt"
    monkeypatch.setattr(
        "sys.argv",
        [
            "trial",
            "--live",
            "--model",
            "openai/gpt-image-2.5/flare/edit",
            "--case",
            "placement",
            "--source",
            str(source),
            "--subject",
            str(subject),
            "--output",
            str(output),
        ],
    )
    monkeypatch.setattr(sketch_trial, "load_dotenv", lambda *_: None)
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    render = AsyncMock(
        return_value=(
            GeneratedImage(png(Image.new("RGB", (1024, 1024))), "image/png", "test", "receipt"),
            0,
        )
    )
    monkeypatch.setattr(sketch_trial, "render_sketch", render)
    await sketch_trial.main()
    request, clean, *_ = render.await_args.args
    assert request.workflow == "placement"
    assert request.scope == "region"
    assert decode(request.subject).getpixel((0, 0)) == (0, 128, 0, 255)
    assert decode(clean).getpixel((0, 0)) == (255, 255, 255, 255)
    mask = decode(request.mask)
    assert mask.getpixel((340, 477)) == (255, 255, 255, 255)
    assert mask.getpixel((800, 477)) == (0, 0, 0, 255)
    assert json.loads((output / "receipt.json").read_text())["outside_changed"] == 0
    with pytest.raises(SystemExit, match="refusing another charge"):
        await sketch_trial.main()
    render.assert_awaited_once()
