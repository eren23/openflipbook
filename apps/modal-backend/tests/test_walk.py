"""providers/walk.py -- a drawn route painted stop by stop into one walk.

The fal boundary is mocked through providers.mock, the same gate every paid
image op rides (#184: one ungated entry point is enough for a "mock" stack to
bill real money). No network, no spend.
"""

from __future__ import annotations

import pytest

from providers import spend, walk

_C = "data:image/png;base64,iVBORw0KGgo="


def _obj(label: str, h_pos: str = "center", distance: float | None = None, visual: str = "") -> walk.SeenObject:
    return walk.SeenObject(label=label, h_pos=h_pos, distance=distance, share=0.2, visual=visual)


def _shot(
    index: int,
    *,
    forward: float | None = 10.0,
    turn_deg: float = 0.0,
    objects: list[walk.SeenObject] | None = None,
) -> walk.WalkShot:
    return walk.WalkShot(
        index=index,
        control_data_url=_C,
        objects=objects if objects is not None else [_obj("Bellfounder Hall", distance=20.0)],
        forward=forward,
        turn_deg=turn_deg,
    )


class _Edits:
    """Counts the paid edits and hands back a distinct frame for each."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def __call__(self, image_data_url: str, instruction: str, **kw: object):
        self.calls.append({"image": image_data_url, "instruction": instruction, **kw})
        return type("G", (), {"jpeg_bytes": f"k{len(self.calls)}".encode(), "mime_type": "image/png"})()


@pytest.fixture
def mocked(monkeypatch: pytest.MonkeyPatch) -> _Edits:
    from providers import image_edit

    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setattr(spend, "reserve", lambda *_a, **_kw: 0.0)
    edits = _Edits()
    monkeypatch.setattr(image_edit, "edit_image", edits)
    return edits


# ── the spec: exactly what the world holds, left to right ──────────────────


def test_describe_lists_the_known_places_left_to_right_with_their_looks() -> None:
    shot = _shot(
        0,
        objects=[
            _obj("Bakery", "right", 6.0, "blue shutters"),
            _obj("Bellfounder Hall", "far-left", 30.0, "teal slate roof"),
            _obj("Well", "center", 12.0),
        ],
    )
    text = walk.describe(shot)
    assert text.index("Bellfounder Hall") < text.index("Well") < text.index("Bakery")
    assert "teal slate roof" in text and "blue shutters" in text
    assert "far left, in the distance" in text and "right, close by" in text


def test_describe_places_the_ground_by_side_and_skips_what_is_behind() -> None:
    shot = walk.WalkShot(
        index=0,
        control_data_url=_C,
        ground=[
            walk.GroundFeature("River Leven", "right", "slow green water"),
            walk.GroundFeature("Market Square", "behind"),
            walk.GroundFeature("River Quay", "here", "a stone pier"),
        ],
    )
    text = walk.describe(shot)
    assert "River Leven is on your right (slow green water)" in text
    assert "You are standing on River Quay (a stone pier)" in text
    assert "Market Square" not in text
    assert "no named building" in text


def test_an_old_client_still_gets_its_names_without_the_slivers() -> None:
    shot = walk.WalkShot(index=0, control_data_url=_C, sees=[("Hall", 0.3), ("Speck", 0.002)])
    assert [o.label for o in shot.seen()] == ["Hall"]


def test_keyframe_names_only_the_spec_and_forbids_inventions() -> None:
    shot = walk.WalkShot(
        index=0, control_data_url=_C, objects=[walk.SeenObject("Bellfounder Hall", "left", color="red")]
    )
    text = walk.keyframe_instruction(shot, styled=True)
    assert "Bellfounder Hall (the red block, left" in text
    assert "block render" in text and "depth" not in text
    # live 2026-09-24: without this the walls came out red, blue and yellow
    assert "never paint a wall or roof in its block colour" in text
    # the correction has no render, so no colours
    assert "red block" not in walk.correction_instruction(shot)
    assert "Do not add any other named building" in text
    assert "Do not move the camera" in text
    assert "Image 2 shows how this town is drawn" in text
    assert "Image 2" not in walk.keyframe_instruction(_shot(0))


def test_a_leg_walks_toward_what_is_ahead_at_the_next_stop() -> None:
    nxt = _shot(1, objects=[_obj("Well", "center"), _obj("Bakery", "far-right")])
    prompt = walk.leg_prompt(nxt)
    assert "toward Well" in prompt and "Bakery" in prompt
    assert "Only the camera moves" in prompt


# ── the move: a straight dolly, never an orbit ─────────────────────────────


def test_push_goes_as_far_as_the_move_toward_what_is_ahead() -> None:
    traj = walk.push(_shot(0, forward=5.0, objects=[_obj("Hall", "center", 20.0)]))
    assert traj[0]["distance"] == 1.0
    assert traj[-1]["distance"] == 0.75
    # H3's azimuth orbits the centre subject, so a leg never uses it
    assert all(p["azimuth"] == 0.0 for p in traj)


def test_push_is_clamped_and_has_a_default() -> None:
    past = walk.push(_shot(0, forward=50.0, objects=[_obj("Hall", "center", 10.0)]))
    assert past[-1]["distance"] == walk.MIN_PUSH
    nothing_ahead = walk.push(_shot(0, objects=[_obj("Hall", "far-left", 10.0)]))
    assert nothing_ahead[-1]["distance"] == 0.5


# ── cost ───────────────────────────────────────────────────────────────────


def test_estimate_is_the_planned_keyframes_the_fixes_and_the_legs() -> None:
    paint = spend.estimate_image(walk.KEYFRAME_MODEL)
    fix = spend.estimate_image(walk.CORRECT_MODEL)
    leg = spend.estimate_video(walk.LEG_MODEL, walk.DEFAULT_CLIP_SECONDS, walk.LEG_RESOLUTION)
    # 4 stops: the last is never edited, so 2 paintings, 1 fix and 3 legs
    assert walk.estimate_usd(4, keyframes=2) == round(2 * paint + 1 * fix + 3 * leg, 4)
    # not knowing the turns, every stop but the last is a fresh painting
    assert walk.estimate_usd(4) == round(3 * paint + 3 * leg, 4)
    assert walk.estimate_usd(1) == round(paint, 4)
    assert walk.estimate_usd(500) == walk.estimate_usd(walk.MAX_SHOTS)


def test_keyframes_are_the_first_stop_and_each_after_a_real_turn() -> None:
    shots = [_shot(0, turn_deg=5.0), _shot(1, turn_deg=-40.0), _shot(2, turn_deg=90.0), _shot(3)]
    # stop 0 and stop 2 (after the turn at 1); the turn at 2 leads into the
    # last stop, which no leg leaves, so it is never painted
    assert walk.keyframes_for(shots) == 2
    assert walk.keyframes_for([_shot(0)]) == 1
    assert walk.keyframes_for([]) == 0


def test_the_models_a_walk_uses_are_priced_not_defaulted() -> None:
    assert spend.estimate_image(walk.KEYFRAME_MODEL) == 0.15
    assert spend.estimate_image(walk.CORRECT_MODEL) == 0.035
    assert spend.estimate_video(walk.LEG_MODEL, 5, walk.LEG_RESOLUTION) == pytest.approx(0.4)


def test_h3_is_priced_per_second_and_turbo_is_not_priced_as_max() -> None:
    turbo = "minimax/h3-max-turbo/image-to-video"
    # fal's pricing API returns only the 480P rate; 768P and 1080P cost more
    assert spend.estimate_video(turbo, 10, "768P") == pytest.approx(0.4)
    assert spend.estimate_video("minimax/h3-max/image-to-video", 10, "768P") == pytest.approx(0.8)
    assert spend.estimate_video("minimax/h3-max/image-to-video", 5, "1080P") == pytest.approx(0.8)
    assert spend.estimate_video("minimax/h3-max/camera-controls", 4, "480P") == pytest.approx(0.2)
    # an unknown resolution is priced at the dearest one
    assert spend.estimate_video(turbo, 5, "4K") == pytest.approx(0.4)
    # a per-clip slug ignores the duration; a bad duration is never a refund
    assert spend.estimate_video("fal-ai/ltx-2.3/image-to-video/fast", 10) == 0.04
    assert spend.estimate_video(turbo, -5) == 0.0


# ── paint ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_straight_walk_paints_once_and_pushes_between_every_stop(mocked: _Edits) -> None:
    result = await walk.paint(session_id="s1", shots=[_shot(0), _shot(2), _shot(4, forward=None)])
    assert len(mocked.calls) == 1  # one keyframe; the rest come from the legs
    assert [(c.from_shot, c.to_shot) for c in result.clips] == [(0, 2), (2, 4)]
    assert [s.index for s in result.snaps] == [0, 2, 4]
    assert len(result.keyframes) == 3
    assert result.video_url is not None
    assert result.spent_usd > 0


@pytest.mark.asyncio
async def test_a_real_turn_cuts_to_a_new_keyframe_at_the_new_heading(mocked: _Edits) -> None:
    shots = [_shot(0, turn_deg=90.0), _shot(1), _shot(2, forward=None)]
    result = await walk.paint(session_id="s1", shots=shots)
    assert len(mocked.calls) == 2
    assert mocked.calls[1]["image"] == _C  # painted from stop 1's own render
    assert len(result.clips) == 2


@pytest.mark.asyncio
async def test_a_turn_into_the_last_stop_paints_nothing_there(mocked: _Edits) -> None:
    result = await walk.paint(session_id="s1", shots=[_shot(0), _shot(1, turn_deg=90.0), _shot(2, forward=None)])
    assert len(mocked.calls) == 1
    # the arrival is the last leg's own frame, not a painting nobody sees
    assert result.snaps[2].image_url != _C and not result.snaps[2].corrected


@pytest.mark.asyncio
async def test_a_small_turn_does_not_cut(mocked: _Edits) -> None:
    await walk.paint(session_id="s1", shots=[_shot(0, turn_deg=8.0), _shot(1, forward=None)])
    assert len(mocked.calls) == 1


@pytest.mark.asyncio
async def test_a_stop_under_the_gate_is_corrected_and_the_next_leg_starts_there(
    mocked: _Edits, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def low(_frame: str, _shot: walk.WalkShot) -> float:
        return 3.0

    monkeypatch.setattr(walk, "_conformance", low)
    result = await walk.paint(session_id="s1", shots=[_shot(0), _shot(1), _shot(2, forward=None)])
    assert len(mocked.calls) == 2  # the keyframe and stop 1's fix; never the last stop
    assert "Keep the camera" in str(mocked.calls[1]["instruction"])
    assert mocked.calls[1]["model_override"] == walk.CORRECT_MODEL
    assert mocked.calls[0]["model_override"] == walk.KEYFRAME_MODEL
    assert mocked.calls[0]["aspect_ratio"] == "1:1"
    assert result.snaps[1].corrected and result.snaps[1].conformance == 3.0
    assert not result.snaps[2].corrected and result.snaps[2].conformance == 3.0


@pytest.mark.asyncio
async def test_a_stop_over_the_gate_is_left_alone(
    mocked: _Edits, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def high(_frame: str, _shot: walk.WalkShot) -> float:
        return 8.5

    monkeypatch.setattr(walk, "_conformance", high)
    result = await walk.paint(session_id="s1", shots=[_shot(0), _shot(1, forward=None)])
    assert len(mocked.calls) == 1
    assert not result.snaps[1].corrected


@pytest.mark.asyncio
async def test_a_judge_that_fails_leaves_the_frame_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    from providers import judge

    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)

    async def boom(*_a: object, **_kw: object) -> None:
        raise RuntimeError("judge down")

    monkeypatch.setattr(judge, "score_spec_conformance", boom)
    assert await walk._conformance(_C, _shot(0)) is None


@pytest.mark.asyncio
async def test_the_judges_median_decides(monkeypatch: pytest.MonkeyPatch) -> None:
    from providers import judge

    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    scores = iter([2.0, 9.0, 7.0])

    async def score(*_a: object, **_kw: object):
        return judge.JudgeResult(score=next(scores), rationale="", raw="")

    monkeypatch.setattr(judge, "score_spec_conformance", score)
    assert await walk._conformance(_C, _shot(0)) == 7.0


@pytest.mark.asyncio
async def test_a_walk_refuses_nothing_and_refuses_too_much() -> None:
    with pytest.raises(ValueError):
        await walk.paint(session_id="s1", shots=[])
    with pytest.raises(ValueError):
        await walk.paint(session_id="s1", shots=[_shot(i) for i in range(walk.MAX_SHOTS + 1)])


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
                control_data_url=_C,
                sees=[("Bellfounder Hall", 0.2)],
                observer=generate.WalkObserver(x=10.0 + i, y=20.0, gaze=0.0),
                move=generate.WalkMove(forward=5.0, turn_deg=0.0) if i < shots - 1 else None,
                objects=[
                    generate.WalkObject(
                        label="Bellfounder Hall", h_pos="center", distance=20.0, visual="x" * 400
                    )
                ],
                ground=[generate.WalkGround(label="River Quay", side="right")],
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
    # three straight stops: one painting, two possible fixes, two legs
    assert payload["estimate_usd"] == walk.estimate_usd(3, keyframes=1)


@pytest.mark.asyncio
async def test_endpoint_hands_the_spec_to_the_walk(monkeypatch: pytest.MonkeyPatch) -> None:
    import generate

    seen: list[walk.WalkShot] = []

    async def spy(**kw: object) -> walk.Walk:
        seen.extend(kw["shots"])  # type: ignore[arg-type]
        return walk.Walk(keyframes=[], clips=[], spent_usd=0.0)

    monkeypatch.setattr(generate, "_rate_limited", lambda _req: None)
    monkeypatch.setattr(walk, "paint", spy)
    await generate.walk(_Req(), _body(2))
    assert seen[0].forward == 5.0 and seen[1].forward is None
    assert seen[0].objects[0].label == "Bellfounder Hall"
    assert len(seen[0].objects[0].visual) == 240  # a long description is cut
    assert seen[0].ground[0].side == "right"


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
    assert [s["index"] for s in payload["snaps"]] == [0, 1, 2]
    assert payload["video_url"]
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


# ── review fixes: money and paid work kept ─────────────────────────────────


def test_over_cap_refuses_what_would_cross_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_SESSION_SPEND", "1")
    monkeypatch.delenv("MAX_DAILY_SPEND", raising=False)
    spend.record("cap-s", 0.5)
    assert spend.over_cap("cap-s") is None
    assert spend.over_cap("cap-s", 0.4) is None
    assert "session spend cap" in (spend.over_cap("cap-s", 0.6) or "")


@pytest.mark.asyncio
async def test_a_walk_that_cannot_finish_under_the_cap_is_refused_before_it_paints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json

    import generate

    monkeypatch.setattr(generate, "_rate_limited", lambda _req: None)
    monkeypatch.setenv("MAX_SESSION_SPEND", "0.5")
    painted: list[object] = []

    async def spy(**kw: object) -> None:
        painted.append(kw)

    monkeypatch.setattr(walk, "paint", spy)
    res = await generate.walk(_Req(), _body(4))
    assert res.status_code == 402
    assert painted == []
    assert json.loads(bytes(res.body))["estimate_usd"] > 0.5


def test_clip_seconds_stays_inside_what_h3_bills() -> None:
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        _body(2, clip_seconds=0)
    with pytest.raises(pydantic.ValidationError):
        _body(2, clip_seconds=16)


@pytest.mark.asyncio
async def test_an_unparseable_reply_is_no_verdict(monkeypatch: pytest.MonkeyPatch) -> None:
    from providers import judge

    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    replies = iter([0.0, 0.0, 8.0])

    async def score(*_a: object, **_kw: object):
        s = next(replies)
        why = judge._UNPARSEABLE_PREFIX + "blank" if s == 0.0 else "fine"
        return judge.JudgeResult(score=s, rationale=why, raw="")

    monkeypatch.setattr(judge, "score_spec_conformance", score)
    # two blank replies must not outvote the one real verdict into a paid fix
    assert await walk._conformance(_C, _shot(0)) == 8.0


@pytest.mark.asyncio
async def test_a_frame_that_cannot_be_read_or_judged_is_left_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)

    async def unreadable(_url: str) -> bytes:
        raise RuntimeError("cdn down")

    monkeypatch.setattr(walk, "_image_bytes", unreadable)
    assert await walk._conformance("https://x/frame.jpg", _shot(0)) is None
    # an old client's names are no spec to judge against
    old = walk.WalkShot(index=0, control_data_url=_C, sees=[("Hall", 0.3)])
    assert await walk._conformance(_C, old) is None


@pytest.mark.asyncio
async def test_a_failed_merge_keeps_the_paid_legs(monkeypatch: pytest.MonkeyPatch) -> None:
    from providers import image

    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)

    async def boom(*_a: object, **_kw: object) -> dict[str, object]:
        raise RuntimeError("merge 500")

    monkeypatch.setattr(image, "_fal_subscribe", boom)
    assert await walk._merge(["https://a.mp4", "https://b.mp4"]) is None


def test_an_old_client_gets_no_made_up_position() -> None:
    old = walk.WalkShot(index=0, control_data_url=_C, sees=[("Hall", 0.3)])
    text = walk.describe(old)
    assert "Hall" in text and "center" not in text and "()" not in text


def test_the_judge_reads_here_as_underfoot() -> None:
    from providers import judge

    lines = judge._spec_lines({"objects": [], "ground": [{"label": "River Quay", "side": "here"}]})
    assert "River Quay underfoot" in lines and "on the here" not in lines


@pytest.mark.asyncio
async def test_edit_image_passes_an_aspect_ratio_through(monkeypatch: pytest.MonkeyPatch) -> None:
    from providers import image_edit

    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    monkeypatch.setenv("FAL_KEY", "test")
    seen: dict[str, object] = {}

    async def subscribe(model: str, args: dict[str, object], **_kw: object) -> dict[str, object]:
        seen.update(args)
        raise RuntimeError("stop here")

    monkeypatch.setattr(image_edit, "_fal_subscribe", subscribe)
    with pytest.raises(RuntimeError, match="stop here"):
        await image_edit.edit_image("https://x/a.png", "paint", model_override=walk.KEYFRAME_MODEL, aspect_ratio="1:1")
    assert seen["aspect_ratio"] == "1:1"
