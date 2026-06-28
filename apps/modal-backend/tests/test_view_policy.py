

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


def test_azimuth_wraps_past_a_full_turn() -> None:
    """A user who keeps re-entering cycles the cardinals rather than running off
    to 450°+."""
    from providers.prompt_library import policy

    assert policy.azimuth_for_enter_index(5) == 90.0  # 450 % 360
    assert policy.azimuth_for_enter_index(8) == 0.0  # 720 % 360


def test_enter_from_closeup_also_rotates_on_revisit() -> None:
    """The from_closeup descent forces eye-level; a re-enter still rotates it to
    a new side (the two signals compose)."""
    from providers.prompt_library import policy

    spec = policy.default_view(
        render_mode="place_scene", world_mode=True, place_form="complex",
        from_closeup=True, enter_index=1,
    )
    assert spec is not None and spec["projection"] == "eye_level"
    assert spec["azimuth_deg"] == 90.0


def test_rotated_oblique_enter_states_the_corner_it_is_viewed_from() -> None:
    """Establishing (oblique) renders azimuth as the COMPLEMENTARY 'from the
    <corner>' (az+180), not 'facing' — the projection-correct wording."""
    from providers import image_edit
    from providers.prompt_library import policy

    view = policy.default_view(
        render_mode="place_scene", world_mode=True, place_form="complex", enter_index=1
    )
    assert view is not None and view["projection"] == "oblique"
    text = image_edit.build_enter_instruction("The Keep", ["a gatehouse"], view=view).lower()
    assert "from the west" in text  # azimuth 90 (east) → viewed from the west
    assert "facing" not in text


def test_negative_enter_index_never_rotates() -> None:
    """A garbage negative count must not spin the camera — defended at the policy
    boundary so a future loosening of generate.py's guard can't leak."""
    from providers.prompt_library import policy

    assert policy.azimuth_for_enter_index(-1) is None
    spec = policy.default_view(
        render_mode="place_scene", world_mode=True, place_form="interior", enter_index=-1
    )
    assert spec is not None and "azimuth_deg" not in spec


def test_astro_scene_stays_legacy_even_with_enter_index() -> None:
    """Astronomical scale has no architectural register (_scene_base → None); a
    stray enter_index must not conjure a rotated camera from it."""
    from providers.prompt_library import policy

    assert policy.default_view(
        render_mode="place_scene", world_mode=True, scale_tier="universe", enter_index=2
    ) is None
