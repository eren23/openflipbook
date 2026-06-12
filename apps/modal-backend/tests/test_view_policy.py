

def test_enter_from_closeup_descends_to_ground_level() -> None:
    """F3: the closeup WAS the establishing shot — entering from it goes to
    ground level even for complex/landscape places (the live failure: every
    loop attempt was another aerial, step_in=2.0, best-of-wide served)."""
    from providers.prompt_library import policy

    spec = policy.default_view(
        render_mode="place_scene",
        world_mode=True,
        place_form="complex",
        from_closeup=True,
    )
    assert spec is not None and spec["projection"] == "eye_level"
    # without the signal, a complex place keeps the establishing oblique
    base = policy.default_view(
        render_mode="place_scene",
        world_mode=True,
        place_form="complex",
    )
    assert base is not None and base["projection"] == "oblique"
