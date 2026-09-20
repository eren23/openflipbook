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
