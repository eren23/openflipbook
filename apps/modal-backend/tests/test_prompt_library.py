"""The prompt library's contract tests.

Three layers: (1) FROZEN GOLDENS — view=None through both import paths must
equal today's pre-grammar strings byte-for-byte (the relocation regression
net; captured by executing the pre-move code); (2) substring-intent pins on
the view-aware camera/instruction/layout output (the research-backed wording
that must not silently rot); (3) the policy decision table.
"""
from __future__ import annotations

import math

from providers import image_edit
from providers.prompt_library import camera, instructions, layout, policy

# --- 1. Frozen goldens (byte-identity: the view=None contract) ---------------

GOLDEN_ENTER_RICH = (
    'Step INSIDE "Sentinel\'s Rise" (a stone castle with concentric walls) — '
    "the place this image shows — and draw the view from ground level within "
    "it. This is the SAME place seen from the inside, not a new one and not "
    "the overhead map view: keep the exact architecture, walls, towers, "
    "materials, colours and landmarks the image shows, and reveal what they "
    "enclose, working in what belongs here: The Inner Bailey; The Watch Bell. "
    "Through openings and beyond the walls, keep the neighbours where the map "
    "placed them: to the north-east, the striped lighthouse on the cliffs. "
    "Keep the exact art medium of the reference — hand-drawn engraving, sepia "
    "ink — same palette and line work; NOT a photograph, no photorealism. "
    "Keep any lettering sparse and legible — no garbled text."
    "\n\nPlace the Inner Bailey at the centre."
)
GOLDEN_ZOOM_RICH = (
    'Zoom into "The Unseen University" — the area at the centre of this image '
    "— and draw a closer, richer map of it. Keep the exact walls, buildings, "
    "towers and landmarks the reference already shows, in the same hand-drawn "
    "engraving style, palette and line work, from the SAME overhead map "
    "viewpoint; do not reinvent them, restyle them, or switch to an eye-level "
    "or interior view. As you move closer, elaborate them with finer "
    "architectural detail, working in the features that belong here: The "
    "Tower of Art; The Library; Great Hall. A closer, faithful continuation "
    "of this exact map, not a new scene. Keep any lettering sparse and "
    "legible — no garbled text."
    "\n\nPlace the Tower of Art toward the upper-left."
)
GOLDEN_LAYOUT = (
    "SCENE LAYOUT (place these exactly where stated — nearest listed first, "
    "keep their relative positions, sizes and front-to-back order): "
    "The Keep — large, center mid; The Mill — small, far-left bottom."
)

_TWO_ENTITIES = [
    {
        "id": "g1", "label": "The Keep", "x_pct": 0.5, "y_pct": 0.5,
        "w_pct": 0.4, "h_pct": 0.4, "depth": 10.0,
        "h_pos": "center", "v_pos": "mid", "size": "large",
    },
    {
        "id": "g2", "label": "The Mill", "x_pct": 0.1, "y_pct": 0.8,
        "w_pct": 0.1, "h_pct": 0.1, "depth": 30.0,
        "h_pos": "far-left", "v_pos": "bottom", "size": "small",
    },
]


def _rich_enter(**over: object) -> str:
    kwargs: dict = {
        "style_anchor": "hand-drawn engraving, sepia ink",
        "subject_context": "a stone castle with concentric walls",
        "surroundings": "to the north-east, the striped lighthouse on the cliffs",
        "layout_clause": "Place the Inner Bailey at the centre.",
    }
    kwargs.update(over)
    return image_edit.build_enter_instruction(
        "Sentinel's Rise", ["The Inner Bailey", "The Watch Bell"], **kwargs
    )


def test_golden_enter_view_none_both_paths() -> None:
    assert _rich_enter() == GOLDEN_ENTER_RICH
    assert (
        instructions.build_enter_instruction(
            "Sentinel's Rise",
            ["The Inner Bailey", "The Watch Bell"],
            style_anchor="hand-drawn engraving, sepia ink",
            subject_context="a stone castle with concentric walls",
            surroundings="to the north-east, the striped lighthouse on the cliffs",
            layout_clause="Place the Inner Bailey at the centre.",
        )
        == GOLDEN_ENTER_RICH
    )


def test_golden_zoom_view_none_both_paths() -> None:
    out = image_edit.build_zoom_instruction(
        "The Unseen University",
        ["The Tower of Art", "The Library", "Great Hall"],
        "Place the Tower of Art toward the upper-left.",
    )
    assert out == GOLDEN_ZOOM_RICH
    assert (
        instructions.build_zoom_instruction(
            "The Unseen University",
            ["The Tower of Art", "The Library", "Great Hall"],
            "Place the Tower of Art toward the upper-left.",
        )
        == GOLDEN_ZOOM_RICH
    )


def test_golden_layout_default_call() -> None:
    assert layout.layout_constraints(_TWO_ENTITIES) == GOLDEN_LAYOUT  # type: ignore[arg-type]


# --- 2a. camera_clause ---------------------------------------------------------

def test_camera_clause_none_and_unknown_are_empty() -> None:
    assert camera.camera_clause(None) == ""
    assert camera.camera_clause({"projection": "weird"}) == ""


def test_camera_top_down_map_register() -> None:
    s = camera.camera_clause(
        {"projection": "top_down", "azimuth_deg": 0.0},
        medium="hand-drawn engraving, sepia ink",
    )
    assert "flat top-down plan view" in s
    assert "looking straight down from directly overhead" in s
    assert "no facades visible" in s and "no horizon" in s
    assert "North is at the top of the map." in s
    assert "NO perspective, no isometric tilt, no vanishing point" in s
    assert "hand-drawn engraving, sepia ink map" in s
    assert "not a satellite photo" in s
    # camera-hardware nouns are photorealism levers — banned on drawn mediums
    low = s.lower()
    assert "drone" not in low and "lens" not in low and "mm" not in s


def test_camera_top_down_without_map_azimuth_skips_north_pin() -> None:
    # A pinned plan view of a SCENE makes no compass claim (V1 nit 18).
    s = camera.camera_clause({"projection": "top_down"})
    assert "North is at the top of the map." not in s


def test_camera_eye_level_facing_and_order() -> None:
    s = camera.camera_clause({"projection": "eye_level", "azimuth_deg": 45.0})
    assert "person's eye level" in s and "visible horizon" in s
    assert "facing north-east" in s
    assert "INSIDE the scene" in s
    assert s.index("eye level") < s.index("Not an overhead")  # positive first


def test_camera_eye_level_rooftop_drops_feet_on_ground() -> None:
    s = camera.camera_clause(
        {"projection": "eye_level", "camera_height": "rooftop"}
    )
    assert "from rooftop height" in s
    assert "feet on the ground" not in s  # the raised-eye negative swap


def test_camera_oblique_default_and_steep() -> None:
    s = camera.camera_clause({"projection": "oblique"})
    assert "tilted down at a classic 45-degree angle" in s
    assert "rooftops and facades equally visible" in s
    steep = camera.camera_clause(
        {"projection": "oblique", "pitch_deg": 60.0, "camera_height": 30.0}
    )
    assert "tilted steeply downward" in steep
    assert "(about 60 degrees below horizontal)" in steep
    assert "thin slivers of the facades" in steep
    assert "from high above the whole area (about 30 m up)" in steep


def test_camera_isometric_never_bare_3d() -> None:
    s = camera.camera_clause({"projection": "isometric"})
    assert "isometric illustration" in s
    assert "axonometric parallel projection" in s and "no vanishing point" in s
    assert "NOT a glossy 3D render" in s
    assert s.count("3D") == s.count("3D render")  # never the bare token
    assert s.index("isometric illustration") < s.index("3D render")


def test_camera_family_grammars() -> None:
    g = camera.camera_clause(
        {"projection": "oblique"}, family="gpt_image"
    )
    assert g.startswith("BOTH the rooftops and the front facades are visible.")
    assert "Constraints: " in g
    k = camera.camera_clause({"projection": "top_down"}, family="kontext")
    assert k == (
        "Maintain the identical flat top-down overhead viewpoint, framing, "
        "and scale; do not tilt the view or add perspective."
    )
    assert "Drawn" not in k  # preserve-only, never a change


def test_compass_and_buckets() -> None:
    assert camera.gaze_to_compass(0.0) == "east"
    assert camera.gaze_to_compass(-math.pi / 2) == "north"
    assert camera.gaze_to_compass(math.pi / 2) == "south"
    assert camera.gaze_to_compass(math.pi) == "west"
    assert camera.gaze_to_compass(-math.pi / 4) == "north-east"
    assert camera.compass_word(22.5) == "north-east"  # JS Math.round semantics
    assert camera.pitch_bucket(80.0) == "top_down"
    assert camera.pitch_bucket(55.0) == "steep"
    assert camera.pitch_bucket(35.0) == "classic"
    assert camera.pitch_bucket(15.0) == "shallow"
    assert camera.pitch_bucket(14.9) == "eye_level"
    assert camera.height_register(1.7) == "eye"
    assert camera.height_register(12) == "rooftop"
    assert camera.height_register(30) == "aerial"
    assert camera.height_register("rooftop") == "rooftop"
    assert camera.height_register("weird") is None
    assert camera.model_family("openrouter:sourceful/riverflow-v2.5-pro") == "gpt_image"
    assert camera.model_family("fal-ai/nano-banana-pro/edit") == "nano"
    assert camera.model_family("fal-ai/flux-pro/kontext") == "kontext"


# --- 2b. view-aware instructions -----------------------------------------------

def test_enter_eye_level_nano_template() -> None:
    s = _rich_enter(
        view={"projection": "eye_level", "azimuth_deg": 45.0, "camera_height": "eye"},
        style_ref=True,
    )
    assert 'Image 1 is the overhead map of "Sentinel\'s Rise"' in s
    assert "Image 2 is only a style reference — take no content from it" in s
    assert "Step inside this exact place" in s
    assert "eye level (camera about 1.7 m up)" in s
    assert "facing north-east" in s
    assert "SAME place as the map" in s
    assert "exactly these landmarks: The Inner Bailey; The Watch Bell" in s
    assert "left/right relations" in s  # NE facing is north-ish: map LR holds
    assert "(map bearings, not view directions)" in s  # register fix (V1 f13)
    assert "striped lighthouse" in s
    assert "Keep the exact art medium of Image 2" in s
    assert "Do not change the input aspect ratio." in s
    assert s.endswith("Place the Inner Bailey at the centre.")
    assert "ground level within it" not in s  # the hardcode is dead here


def test_enter_south_facing_drops_map_left_right() -> None:
    s = _rich_enter(view={"projection": "eye_level", "azimuth_deg": 180.0})
    assert "consistent with the map" not in s  # facing south inverts map LR
    assert "as seen from this viewpoint" in s


def test_enter_isometric_and_oblique_registers() -> None:
    iso = _rich_enter(view={"projection": "isometric", "azimuth_deg": 135.0, "pitch_deg": 35.0})
    assert "isometric illustration from the north-west" in iso
    assert "parallel edges" in iso and "no perspective convergence" in iso
    assert iso.count("3D") == iso.count("3D render")
    obl = _rich_enter(view={"projection": "oblique", "pitch_deg": 60.0})
    assert "high-angle oblique aerial view" in obl
    assert "about 60 degrees below horizontal" in obl
    assert "rooftops AND the front faces" in obl
    assert "No tilt-shift miniature effect" in obl


def test_enter_top_down_is_a_plan_not_legacy_fallback() -> None:
    # V1 BLOCKER 2: the 2D-plan pill must be honored, not silently eye-level.
    s = _rich_enter(view={"projection": "top_down"})
    assert "flat top-down plan map" in s
    assert "looking straight down from directly overhead" in s
    assert "ground level within it" not in s


def test_enter_gpt_and_kontext_families() -> None:
    g = _rich_enter(
        view={"projection": "eye_level"}, family="gpt_image", style_ref=True
    )
    assert g.startswith("Change only the camera:")
    assert "Preserve: the architecture and building shapes" in g
    assert "Constraints:" in g and g.index("Preserve:") < g.index("Constraints:")
    assert "Eye-level first-person view only" in g
    k = _rich_enter(view={"projection": "eye_level"}, family="kontext")
    assert k.startswith("Change the view to ground level inside this exact")
    assert "while preserving its exact architecture" in k
    assert "Image 1" not in k  # singular-ref model: no image-role naming


def test_zoom_preserve_any_projection() -> None:
    td = image_edit.build_zoom_instruction(
        "The Tower", ["x"], "", style_anchor="woodcut", view={"projection": "top_down"}
    )
    assert "the exact same overhead camera angle" in td
    assert "same woodcut style" in td
    eye = image_edit.build_zoom_instruction(
        "The Tower", [], "", view={"projection": "eye_level"}
    )
    assert "the exact same eye-level camera angle" in eye
    assert "a different viewpoint or projection" in eye


def test_outward_clause_registers() -> None:
    assert instructions.outward_clause(None) == ""
    td = instructions.outward_clause({"projection": "top_down"})
    assert "flat top-down overhead" in td and "the camera simply rises" in td
    assert "nothing inside the original view changes or rescales" in td
    assert "pulls back" in instructions.outward_clause({"projection": "eye_level"})


# --- 2c. layout extensions ------------------------------------------------------

def _ent(label: str, depth: float, x: float = 0.5, y: float = 0.5,
         w: float = 0.2, h: float = 0.2) -> dict:
    return {
        "id": label, "label": label, "x_pct": x, "y_pct": y, "w_pct": w,
        "h_pct": h, "depth": depth, "h_pos": "center", "v_pos": "mid",
        "size": "medium",
    }


def test_heights_clause_filters_and_words() -> None:
    s = layout.layout_constraints(
        _TWO_ENTITIES,  # type: ignore[arg-type]
        heights=[
            ("The Tower", 5.0, "a cottage"),
            ("The Walls", 2.0, "a cottage"),
            ("The Shed", 1.2, "a cottage"),
        ],
    )
    assert "RELATIVE HEIGHTS (true vertical proportions):" in s
    assert "The Tower rises about 5x the height of a cottage" in s
    assert "2x" in s
    assert "The Shed" not in s  # 1.2 is noise, filtered
    assert " m " not in s and "meter" not in s.lower()  # never absolute units


def test_depth_layers_and_occlusion() -> None:
    ents = [
        _ent("A", 5.0), _ent("B", 8.0), _ent("C", 20.0),
        _ent("D", 25.0), _ent("E", 60.0), _ent("F", 80.0),
    ]
    s = layout.layout_constraints(ents, depth_layers=True)  # type: ignore[arg-type]
    assert "DEPTH LAYERS (front to back): foreground — " in s
    assert s.index("SCENE LAYOUT") < s.index("DEPTH LAYERS")
    assert "is partially hidden behind" in s  # overlapping rects + depth gap
    flat = [_ent("A", 10.0), _ent("B", 10.5), _ent("C", 11.0)]
    assert "DEPTH LAYERS" not in layout.layout_constraints(flat, depth_layers=True)  # type: ignore[arg-type]


def test_layout_folding_cap() -> None:
    ents = [_ent(f"E{i}", float(i + 1)) for i in range(9)]
    s = layout.layout_constraints(ents, max_entity_lines=6)  # type: ignore[arg-type]
    assert s.count("—") >= 6
    assert "; the rest in the background, smallest and farthest — " in s
    assert "E6" in s and "E7" in s and "E8" in s  # folded, never truncated
    # no folding by default
    full = layout.layout_constraints(ents)  # type: ignore[arg-type]
    assert "the rest in the background" not in full


# --- 3. policy decision table ----------------------------------------------------

def test_policy_root_map_cells() -> None:
    # V1 BLOCKER 1: the describe-a-place ROOT arrives as place_submap with no
    # region crop — it must get the locked flat top-down camera.
    v = policy.default_view(render_mode="place_submap", world_mode=True, has_region=False)
    assert v is not None and v["projection"] == "top_down"
    assert v["azimuth_deg"] == 0.0 and v["source"] == "policy"
    # WITH a region it is a Kontext zoom-continue: policy stays silent.
    assert policy.default_view(render_mode="place_submap", world_mode=True, has_region=True) is None
    # query-path world map
    q = policy.default_view(render_mode=None, world_mode=True)
    assert q is not None and q["projection"] == "top_down"
    # classic non-world query: legacy bytes
    assert policy.default_view(render_mode=None, world_mode=False) is None


def test_policy_scene_cascade() -> None:
    base: dict = {"render_mode": "place_scene", "world_mode": True}
    castle = policy.default_view(**base, subject="The Stone Castle", subject_context="a castle on a hill")
    assert castle is not None and castle["projection"] == "oblique"
    hall = policy.default_view(**base, subject="the castle's great hall")
    assert hall is not None and hall["projection"] == "eye_level"  # interior beats complex
    person = policy.default_view(**base, subject="The Harbormaster", focus_kind="person")
    assert person is not None and person["projection"] == "eye_level"
    eye_pill = policy.default_view(**base, level="eye", subject="castle")
    assert eye_pill is not None and eye_pill["projection"] == "eye_level"  # S1 wins
    # the classifier's locale-proof read beats the English tables (V1 f6)
    tr = policy.default_view(
        **base,
        place_form="interior",
        subject="Karanlık Meyhane",  # noqa: RUF001 — deliberately Turkish (the locale case)
    )
    assert tr is not None and tr["projection"] == "eye_level"
    tr2 = policy.default_view(**base, place_form="complex", subject="Büyük Kale")
    assert tr2 is not None and tr2["projection"] == "oblique"
    # unmatched non-English at tier "place" falls SAFE (eye), not aerial
    unk = policy.default_view(**base, subject="Meyhane", scale_tier="place")
    assert unk is not None and unk["projection"] == "eye_level"
    # real footprint signals
    big = policy.default_view(**base, subject="X", focus_footprint=(20.0, 15.0))
    assert big is not None and big["projection"] == "oblique"
    fake = policy.default_view(**base, subject="X", focus_footprint=(6.0, 6.0))
    assert fake is not None and fake["projection"] == "eye_level"  # seed constant ignored -> S7
    # city tier still establishes
    city = policy.default_view(**base, subject="X", scale_tier="city")
    assert city is not None and city["projection"] == "oblique"


def test_policy_ascend_and_estimator() -> None:
    up = policy.default_view(render_mode="scale_parent", world_mode=True, scale_tier="region")
    assert up is not None and up["projection"] == "top_down"
    assert policy.default_view(render_mode="scale_parent", world_mode=True, scale_tier="galaxy") is None
    est = policy.estimate_to_view_spec({"projection": "perspective", "pitch_deg": -5.0})
    assert est == {"projection": "eye_level", "pitch_deg": -5.0, "source": "estimated"}
    assert policy.estimate_to_view_spec({"projection": "junk"})["projection"] == "top_down"
