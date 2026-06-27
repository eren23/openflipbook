

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


def test_azimuth_for_enter_index_rotates_only_on_revisit() -> None:
    """The 'another angle' schedule: the first enter (0/None) states no azimuth
    (byte-identical to today); each re-enter rotates the camera one 90° step,
    wrapping at four."""
    from providers.prompt_library import policy

    assert policy.azimuth_for_enter_index(None) is None
    assert policy.azimuth_for_enter_index(0) is None
    assert policy.azimuth_for_enter_index(1) == 90.0
    assert policy.azimuth_for_enter_index(2) == 180.0
    assert policy.azimuth_for_enter_index(3) == 270.0
    assert policy.azimuth_for_enter_index(4) == 0.0  # wraps back to north


def test_scene_enter_first_view_has_no_azimuth_then_rotates() -> None:
    """First enter: byte-identical (no azimuth on the scene spec). Re-enter:
    the same place + projection, rotated to a new side."""
    from providers.prompt_library import policy

    first = policy.default_view(
        render_mode="place_scene", world_mode=True, place_form="interior"
    )
    assert first is not None and first["projection"] == "eye_level"
    assert "azimuth_deg" not in first  # unchanged first view

    second = policy.default_view(
        render_mode="place_scene", world_mode=True, place_form="interior", enter_index=1
    )
    assert second is not None and second["projection"] == "eye_level"
    assert second["azimuth_deg"] == 90.0  # same place, now facing east


def test_oblique_establishing_also_rotates_on_revisit() -> None:
    """Rotation applies to the establishing (aerial) register too — another
    compass side of the complex, not just interiors."""
    from providers.prompt_library import policy

    rot = policy.default_view(
        render_mode="place_scene", world_mode=True, place_form="complex", enter_index=2
    )
    assert rot is not None and rot["projection"] == "oblique"
    assert rot["azimuth_deg"] == 180.0


def test_top_down_map_is_north_locked_despite_enter_index() -> None:
    """Maps are the north-at-top pin — a stray enter_index must never spin a
    plan map off its locked azimuth 0."""
    from providers.prompt_library import policy

    m = policy.default_view(
        render_mode="place_submap", world_mode=True, has_region=False, enter_index=3
    )
    assert m is not None and m["projection"] == "top_down"
    assert m["azimuth_deg"] == 0.0


def test_rotated_enter_instruction_states_the_new_facing() -> None:
    """End-to-end through the prompt builder: the rotated azimuth surfaces as a
    'facing <compass>' clause (90° → east), no instruction-builder change."""
    from providers import image_edit
    from providers.prompt_library import policy

    view = policy.default_view(
        render_mode="place_scene", world_mode=True, place_form="interior", enter_index=1
    )
    text = image_edit.build_enter_instruction("The Hall", ["a long table"], view=view).lower()
    assert "facing" in text and "east" in text
