"""providers/walk.py -- a drawn route painted into keyframes and clips.

The fal boundary is mocked through providers.mock, the same gate every paid
image op rides (#184: one ungated entry point is enough for a "mock" stack to
bill real money). No network, no spend.
"""

from __future__ import annotations

import pytest

from providers import spend, walk


def _shot(index: int, sees: list[tuple[str, float]] | None = None) -> walk.WalkShot:
    return walk.WalkShot(
        index=index,
        control_data_url="data:image/png;base64,iVBORw0KGgo=",
        sees=sees if sees is not None else [("Bellfounder Hall", 0.2)],
    )


def test_instruction_names_what_the_shot_sees() -> None:
    text = walk.shot_instruction([("The Copper Kettle", 0.28), ("Lantern Watch", 0.04)])
    assert "The Copper Kettle" in text
    assert "Lantern Watch" in text
    # the camera is the render's, never the model's
    assert "Do not move the camera" in text


def test_instruction_ignores_slivers_and_survives_an_empty_view() -> None:
    # a place covering under a percent of frame is not what the shot is OF
    assert "Speck" not in walk.shot_instruction([("Hall", 0.3), ("Speck", 0.002)])
    assert walk.shot_instruction([]).count("camera") >= 1


def test_the_models_a_walk_uses_are_priced_not_defaulted() -> None:
    # Unpriced, both fell to the 0.15 image default: four times what fal bills
    # for a keyframe, so a session cap tripped four times early.
    assert spend.estimate_image(walk.KEYFRAME_MODEL) == 0.035
    assert spend.estimate_video("minimax/h3-max/image-to-video") == pytest.approx(0.125)
    # longest prefix wins, so the 2.3 slugs do not collide
    assert spend.estimate_video("fal-ai/ltx-2.3/image-to-video/fast") == 0.04
    assert spend.estimate_video("fal-ai/ltx-2.3-quality/reference-video-to-video") == 0.12
    # an unknown slug stays conservative rather than free
    assert spend.estimate_video("who/knows") == spend._DEFAULT_IMAGE_PRICE


def test_h3_is_priced_per_second_and_turbo_is_not_priced_as_max() -> None:
    turbo = "minimax/h3-max-turbo/image-to-video"
    assert spend.estimate_video(turbo, 10) == pytest.approx(0.125)
    assert spend.estimate_video("minimax/h3-max/image-to-video", 10) == pytest.approx(0.25)
    assert spend.estimate_video("minimax/h3-max/camera-controls", 4) == pytest.approx(0.1)
    # a per-clip slug ignores the duration; a bad duration is never a refund
    assert spend.estimate_video("fal-ai/ltx-2.3/image-to-video/fast", 10) == 0.04
    assert spend.estimate_video(turbo, -5) == 0.0


def test_estimate_follows_the_descent_slot_actually_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAL_DESCENT_MODEL", "minimax/h3-max/image-to-video")
    h3 = walk.estimate_usd(5)
    monkeypatch.setenv("FAL_DESCENT_MODEL", "fal-ai/ltx-video/image-to-video")
    assert walk.estimate_usd(5) < h3


def test_estimate_is_frames_plus_the_gaps_between_them() -> None:
    one = walk.estimate_usd(1)
    four = walk.estimate_usd(4)
    assert one > 0
    # 4 shots is 4 frames and 3 clips, so it costs more than 4x a lone frame
    assert four > one * 4
    # and the cap bounds it however many shots are asked for
    assert walk.estimate_usd(500) == walk.estimate_usd(walk.MAX_SHOTS)


@pytest.mark.asyncio
async def test_paint_makes_a_keyframe_per_shot_and_a_clip_per_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setattr(spend, "reserve", lambda *_args, **_kw: 0.0)
    result = await walk.paint(session_id="s1", shots=[_shot(0), _shot(2), _shot(4)])
    assert len(result.keyframes) == 3
    assert len(result.clips) == 2
    assert [(c.from_shot, c.to_shot) for c in result.clips] == [(0, 2), (2, 4)]
    assert all(k.startswith("data:") for k in result.keyframes)
    assert result.spent_usd > 0


@pytest.mark.asyncio
async def test_a_single_shot_paints_but_links_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setattr(spend, "reserve", lambda *_args, **_kw: 0.0)
    result = await walk.paint(session_id="s1", shots=[_shot(0)])
    assert len(result.keyframes) == 1
    assert result.clips == []


@pytest.mark.asyncio
async def test_a_walk_refuses_nothing_and_refuses_too_much() -> None:
    with pytest.raises(ValueError):
        await walk.paint(session_id="s1", shots=[])
    with pytest.raises(ValueError):
        await walk.paint(
            session_id="s1", shots=[_shot(i) for i in range(walk.MAX_SHOTS + 1)]
        )


@pytest.mark.asyncio
async def test_the_spend_cap_stops_a_walk_before_it_paints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")

    def refuse(*_args: object, **_kw: object) -> float:
        raise RuntimeError("session cap reached")

    monkeypatch.setattr(spend, "reserve", refuse)
    with pytest.raises(RuntimeError, match="cap"):
        await walk.paint(session_id="s1", shots=[_shot(0), _shot(1)])


# ── the /walk endpoint ──────────────────────────────────────────────────────


class _Req:
    """Enough Request for the handler: headers, and an IP for the limiter."""

    def __init__(self) -> None:
        self.headers: dict[str, str] = {}
        self.client = type("C", (), {"host": "127.0.0.1"})()


def _body(shots: int, **kw: object):
    import generate

    return generate.WalkBody(
        session_id="s1",
        shots=[
            generate.WalkShotBody(
                index=i,
                control_data_url="data:image/png;base64,iVBORw0KGgo=",
                sees=[("Bellfounder Hall", 0.2)],
            )
            for i in range(shots)
        ],
        **kw,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_estimate_only_prices_a_walk_without_painting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json

    import generate

    monkeypatch.setattr(generate, "_rate_limited", lambda _req: None)
    res = await generate.walk(_Req(), _body(3, estimate_only=True))
    payload = json.loads(bytes(res.body))
    assert payload["shots"] == 3
    assert payload["estimate_usd"] == walk.estimate_usd(3)


@pytest.mark.asyncio
async def test_endpoint_paints_and_reports_what_it_spent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json

    import generate

    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setattr(generate, "_rate_limited", lambda _req: None)
    monkeypatch.setattr(spend, "reserve", lambda *_a, **_kw: 0.0)
    res = await generate.walk(_Req(), _body(3))
    payload = json.loads(bytes(res.body))
    assert len(payload["keyframes"]) == 3
    assert len(payload["clips"]) == 2
    assert payload["clips"][0]["from_shot"] == 0
    assert payload["spent_usd"] > 0


@pytest.mark.asyncio
async def test_endpoint_refuses_an_empty_walk_as_a_bad_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import generate

    monkeypatch.setattr(generate, "_rate_limited", lambda _req: None)
    res = await generate.walk(_Req(), _body(0))
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_a_provider_failure_becomes_a_502_not_a_crash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import generate

    monkeypatch.setattr(generate, "_rate_limited", lambda _req: None)

    async def boom(**_kw: object) -> None:
        raise RuntimeError("fal said no")

    monkeypatch.setattr(walk, "paint", boom)
    res = await generate.walk(_Req(), _body(2))
    assert res.status_code == 502


# ── the grounded path (a shot that carries its map) ─────────────────────────


def test_a_grounded_shot_is_painted_by_the_enter_model() -> None:
    assert walk._frame_model(grounded=True) == walk.ENTER_MODEL
    assert walk._frame_model(grounded=False) == walk.KEYFRAME_MODEL


def test_grounded_instruction_leads_with_the_map_and_asks_for_eye_level() -> None:
    text = walk.shot_instruction([("The Copper Kettle", 0.3)], grounded=True)
    assert "map" in text
    assert "eye level" in text
    assert "The Copper Kettle" in text
    # the whole point: it must refuse to hand back another aerial view
    assert "not an aerial" in text


@pytest.mark.asyncio
async def test_a_grounded_shot_sends_the_map_and_NOT_the_box_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Research 19 ran the enter model against a simplified proxy guide four
    times and it failed architecture every run -- the guide's form came through
    instead of the real building. A box render is that guide, so a grounded
    shot must send the map alone."""
    from providers import image_edit

    seen: dict[str, object] = {}

    async def spy(image_data_url: str, instruction: str, **kw: object):
        seen["image"] = image_data_url
        seen["kw"] = kw
        return type("G", (), {"jpeg_bytes": b"x", "mime_type": "image/png"})()

    monkeypatch.setattr(image_edit, "edit_image", spy)
    monkeypatch.setattr(spend, "reserve", lambda *_a, **_kw: 0.0)
    shot = walk.WalkShot(
        index=0,
        control_data_url="data:image/png;base64,CONTROL",
        sees=[("Hall", 0.3)],
        surroundings_data_url="data:image/png;base64,MAP",
    )
    await walk.paint(session_id="s1", shots=[shot])
    assert seen["image"] == "data:image/png;base64,MAP"
    kw = seen["kw"]
    assert isinstance(kw, dict)
    assert kw.get("model_override") == walk.ENTER_MODEL
    assert "identity_ref_url" not in kw


def test_a_grounded_walk_is_quoted_at_the_enter_model_price() -> None:
    assert walk.estimate_usd(4, grounded=True) > walk.estimate_usd(4, grounded=False)
