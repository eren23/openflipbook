import httpx
import pytest

from tests.continuity_bench import lighthouse_control_pilot as pilot


@pytest.mark.parametrize("variant", pilot.VARIANTS)
def test_frozen_payloads_have_one_image_bounded_size_and_seed(variant):
    model, args, amount = pilot.arguments(variant, 521, "crop", "guide")
    assert args["num_images"] == 1 and args["seed"] == 521
    assert amount <= .2
    if model == pilot.MODEL:
        assert args["image_urls"] == ["guide", "crop"]
        assert args["resolution"] == "1K" and args["aspect_ratio"] == "16:9"
        assert not args["enable_web_search"]
    else:
        assert args["image_urls"] == ["crop"]
        assert args["image_size"] == {"width": 1280, "height": 720}
        assert args["vertical_angle"] == (-30 if variant == "qwen_low" else 0)
        assert args["enable_safety_checker"]


@pytest.mark.parametrize("variant,seed,guide", [("unknown", 521, "guide"), ("guide_color", 123, "guide"), ("guide_clay", 521, None)])
def test_unapproved_trial_arguments_fail(variant, seed, guide):
    with pytest.raises(ValueError):
        pilot.arguments(variant, seed, "crop", guide)


@pytest.mark.parametrize("axis", pilot.ARCH_AXES)
@pytest.mark.parametrize("state", ["fail", "unknown", None, True])
def test_architecture_cannot_average_away_a_failed_feature(axis, state):
    value = {"checks": {**dict.fromkeys(pilot.ARCH_AXES, "pass"), axis: state}}
    assert not pilot.architecture_result(value)["accepted"]
    assert not pilot.architecture_result({})["accepted"]


async def test_no_paid_run_without_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("LIGHTHOUSE_CONTROL_PILOT", raising=False)
    with pytest.raises(RuntimeError, match="approved"):
        await pilot.run()


def test_complete_architectural_evidence_can_pass():
    assert pilot.architecture_result({"checks": dict.fromkeys(pilot.ARCH_AXES, "pass")})["accepted"]


@pytest.mark.parametrize("change", [
    {}, {"unit_price": .041}, {"unit_price": 0}, {"unit_price": -1},
    {"currency": "EUR"}, {"unit": "seconds"},
])
async def test_live_quote_rejects_unapproved_pricing_without_generation(change):
    rows = [
        {"endpoint_id": pilot.MODEL, "unit_price": .15, "currency": "USD", "unit": "images"},
        {"endpoint_id": pilot.QWEN, "unit_price": .035, "currency": "USD", "unit": "megapixels", **change},
    ]
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"prices": rows})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        if change:
            with pytest.raises(ValueError, match="Pricing"):
                await pilot.quote(client, {})
        else:
            assert (await pilot.quote(client, {}))["prices"] == rows
    assert len(calls) == 1 and calls[0].method == "GET"
