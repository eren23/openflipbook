# 08 — Camera prompting: what vocabulary actually moves projection (2025–2026)

_Web-grounded (R1, view-grammar wave 1). Feeds `providers/prompt_library/` —
the `_PROJECTION_LANGUAGE` dict and the pitch/azimuth/height/fov phrasing
templates that `ViewSpec` (generate.py) will compile into prompt clauses.
Production families covered: Gemini image (nano-banana / Flash Image /
Gemini 3 Pro Image), OpenAI gpt-image, FLUX incl. Kontext, plus Seedream and
general community/papers evidence._

## TL;DR (the five load-bearing findings)

1. **Qualitative registers move models; raw numbers mostly don't.** Two 2025–26
   papers built parametric camera modules *because* text fails at precise
   angles: PreciseCam ("precise control is missing in current text-to-image
   models") and the viewpoint-tokens paper, which showed GPT-5 generating
   near-identical orientations for "seen from 45°/30° to the left/right"
   prompts — "natural language is expressive but inherently ambiguous and
   discrete for viewpoint specification". Community replicates this:
   "30° yaw, 20° pitch" was flatly ignored by gpt-image; what worked was
   face-visibility language ("The RIGHT face is the broad, closest face to
   camera", "observer stands at the front-right corner").
   → Emit numbers only as *register hints* bucketed into words, never as the
   sole carrier.
2. **Every official guide endorses photographic/cinematic vocabulary** —
   "low angle", "aerial view", "top-down drone perspective looking directly
   down", "eye-level shot", lens mm and f-stops. But lens/camera-hardware words
   are *also* photorealism style triggers (that's exactly why the guides
   recommend them for realism). → For our hand-drawn mediums, express
   projection as a property of the **drawing** ("drawn in flat plan view"),
   not of a **camera** ("shot from a drone"), except on deliberately
   photographic styles.
3. **Suppression needs both halves**: a positive restatement ("rooftops only,
   every facade hidden, uniform scale across the sheet") *plus* a short
   explicit negative ("no isometric tilt, no vanishing point, no horizon").
   Gemini's official line is positive-first ("describe 'an empty street'
   instead of 'no cars'"), but gpt-image-1.5's official guide explicitly
   endorses exclusion lists ("no watermark, no extra text"), and our own
   shipped `WORLD_TOPDOWN_MAPS` clause ("FLAT TOP-DOWN … NO perspective or
   isometric tilt") works on Gemini. Negation-only prompts fail (OpenAI forum
   "no tracks" thread).
4. **Kontext cannot be asked to move the camera.** Community + LoRA ecosystem
   agree: viewpoint-change prompts rotate the *subject*, not the camera (a
   dedicated "Change Camera Angle" Kontext LoRA exists because of this).
   Kontext's contract is same-view edits: every Kontext clause must *preserve*
   ("maintain identical camera angle, framing, and perspective"), never
   *change* projection. Projection changes belong to Gemini/gpt-image/Seedream
   edit endpoints, which demonstrably re-angle ("Show this scene from a bird's
   eye view" works on nano-banana-pro; Seedream "nails the new top-down
   perspective while maintaining the original style").
5. **Ordering**: Gemini = narrative scene first, composition/camera mid-to-late
   ([Subject]+[Action]+[Location]+[Composition]+[Style]), no keyword spam.
   gpt-image = consistent block order scene→subject→details→**constraints at
   the end**, and *repeat the preserve list on every edit iteration*. FLUX =
   front-load ("FLUX pays more attention to what you mention first"), 512-token
   cap on Kontext. Caps-for-emphasis has no official backing anywhere but is
   harmless and common in working community prompts (and in ours).

---

## 1. Trigger vocabulary per projection

### 1a. Flat top-down orthographic plan (`top_down`)

| What | Vocabulary | Evidence |
|---|---|---|
| Core trigger | "flat top-down view, looking straight down", "overhead map", "plan view", "orthographic projection" | DeepMind prompt guide demos "top-down drone perspective looking directly down"; Google Cloud guide lists "aerial view" as a control term; architecture community gets clean plans/elevations out of nano-banana with "draw a 2D elevation … as a simple drawing on a white background" (fenestra.app) |
| Photographic register (only for photo mediums) | "nadir shot", "satellite view", "orthophoto" | Drone-survey corpus: nadir/vertical = camera at 90° down, "no visible horizon or sides of structures" (flyingglass.com.au, autelpilot.com) — the definition itself is the best suppression sentence |
| Positive suppression | "every building seen roof-on, no facades visible", "no horizon line anywhere on the sheet", "uniform scale — nothing nearer or farther" | Gemini official: positive framing beats bare negation ("empty street" not "no cars"); OpenAI forum: negation-only ("no tracks") failed repeatedly |
| Negative guard | "NO perspective, no isometric tilt, no vanishing point" | Our shipped `_topdown_clause_for` (generate.py) — validated in-product; gpt-image-1.5 guide endorses explicit exclusions |
| Known drift | models relax into "accidental 2.5D" oblique; "satellite view" drags photoreal; "bird's eye" alone often lands oblique, not nadir | game-dev reports: "top-down oblique" requests collapse into true top-down / front view / isometric at random; our own map renders drift unless flag forces flat |

**Key nuance:** "bird's-eye view" is NOT a reliable synonym for top-down — in
the cinematography register it merely means "high above"; community guides use
it for both nadir and oblique. Use "looking straight down / directly overhead"
as the disambiguator (techyheaven's working nano-banana prompt: "Direct
overhead bird's-eye view … Camera top-down").

### 1b. Oblique bird's-eye at ~45° (`oblique`)

| What | Vocabulary | Evidence |
|---|---|---|
| Core trigger | "high-angle aerial view at a 45-degree angle, looking down on the scene so that both rooftops and facades are visible" | Aerial-photography register: oblique imagery is *defined* as 40–45° tilt showing top + sides (jouav.com, autelpilot.com) — models have this corpus; OpenAI's own cookbook uses "consistent 45-degree angle" in its isometric grid example, so "45-degree" works as a register token |
| Game register | "three-quarter top-down view, 2.5D, like a classic RPG/city-builder map" | retronator's graphical-projections guide (the community's canonical taxonomy); aituts isometric guide |
| The facade test | say what's visible: "rooftops AND the front faces of buildings both visible" | OpenAI forum finding: describing **which faces are visible** beats degrees ("The RIGHT face is the broad, closest face…") — the single most reliable trick for in-between angles |
| Negative guard | "not straight down, not eye level — keep the elevated three-quarter angle; no fisheye" | symmetric guard against collapse into the two attractors (nadir / ground) observed in game-dev reports |
| Known drift | "aerial city at 45°" pulls **tilt-shift miniature** photography (community example prompts add it on purpose) | sider.ai bird's-eye example: "…tilt-shift miniature effect" — for us that's medium drift, guard it on photo styles |

**Pitch numbers here are register, not measurement**: "45-degree" reliably
selects the oblique register because the corpus is saturated with it; 30° vs
55° will not be honored as distinct angles (papers above). Bucket pitch into
{shallow ≈30°, classic ≈45°, steep ≈60°} words.

### 1c. True isometric / axonometric (`isometric`)

| What | Vocabulary | Evidence |
|---|---|---|
| Core trigger | lead with "isometric view of…" / "isometric illustration of…" | aituts: "isometric" appears at the head of every working Midjourney/FLUX prompt; PromptHero corpus same |
| Reinforcers | "axonometric, parallel projection, no vanishing point, all verticals parallel", "equal 120° axes" | architectural-drawing register (firstinarchitecture.co.uk; midlibrary "Axonometric view" style); fenestra got clean axons from nano-banana with "create an axonometric diagram … on a white background" |
| Game register | "isometric game art, diorama on a plain background, single tile" | aituts; PromptBase FLUX isometric prompts; "diorama" + "white/plain background" keeps the object bounded |
| Negative guard | "not a perspective render — parallel projection only; no foreshortening, no vanishing point" | the converse of the perspective definition (vanishing points) — see retronator taxonomy |
| Known drift | THE trap: "isometric" drags into glossy 3D-render aesthetics (Blender/Octane/C4D look, soft global illumination, tech-startup style) | Grokipedia "3D Render vs 2D Illustration in AI Prompts": "3D render" register = realistic lighting/shadows/depth, "2D illustration" register = flat colors + linework; aituts counters with "clean pixel art", "flat shading"; IBM Design Language defines isometric *illustration* as flat-shaded — that's the register to invoke |

### 1d. Eye-level / first-person (`eye_level`)

| What | Vocabulary | Evidence |
|---|---|---|
| Core trigger | "eye-level shot from where a person stands", "standing at ground level inside the place, looking ahead" | DeepMind guide demo: "realistic eye-level shot of an all-black Himalayan wolf"; gpt-image-1.5 official: "perspective/angle (eye-level, low-angle)"; our `build_enter_instruction` already ships "from ground level within it" and works |
| First-person variant | "first-person point of view", "POV shot, foreground elements close to the viewer" | imaginewithrashid nano-banana set: "point of view shot … hands visible in the foreground" |
| Depth cue | "natural perspective with a visible horizon; distant things smaller" | inverse of the top-down suppression — stating the horizon *back on* is the cheap way to force ground level |
| Negative guard | "not an overhead or map view — the viewer is INSIDE the scene" | our shipped enter clause ("not the overhead map view") — validated by the enter eval |
| Low-angle / worm's-eye sibling | "low-angle shot looking up at…", "worm's-eye view from the ground looking straight up" | Google Cloud guide: "force the perspective by explicitly requesting a 'low-angle shot with a shallow depth of field (f/1.8)'"; standard across all camera-vocab guides (colorbliss, popai, mimicpc) |

## 2. Numeric parameters: what the evidence says

| Parameter | Verdict | Evidence |
|---|---|---|
| **pitch/yaw degrees** ("camera tilted 37° below horizontal") | ✗ as measurement, ✓ as register token for the canonical values (45°, 90°/straight down) | PreciseCam (arXiv:2501.12910) and viewpoint-tokens (arXiv:2604.19954) both exist because text fails; the latter's GPT-5 test produced near-identical images for 45° vs 30° prompts; OpenAI forum: "30° yaw, 20° pitch" ignored. Canonical degrees ride the photography corpus (oblique=45°, nadir=90°) |
| **compass bearings** ("facing north-east") | ✗ for free cameras; ✓ only on maps via the cartographic convention "north at the top of the map" | zero positive evidence in any guide/community thread for bearing-controlled cameras (colorbliss/venice/popai corpus has none); maps are the exception because "north is up" is a drawing convention, not a camera fact. For scenes, use **relational azimuth**: "looking toward the [named landmark]" — spatial-relation language is what the OpenAI forum found reliable |
| **eye/camera height** ("from 1.7 m" vs "from a drone at 100 m") | ~ numbers tolerated but the *register noun* does the work | guides use nouns: "drone shot", "rooftop view", "eye level", "ground level"; aerial-survey corpus gives "low-altitude drone" vs "high-altitude aerial"; no guide demonstrates metric heights changing output. Emit "from about 100 m up (high drone altitude)" — number + register noun |
| **lens / FOV** ("wide 24mm", "telephoto 200mm", f-stops) | ✓ officially endorsed by all families — but as *look* selectors, and they import the photographic medium | Google Cloud: "wide-angle lens" for scale, "macro lens" for detail, "(f/1.8)"; gpt-image-1.5: lens/aperture terms "steer realism more reliably than generic '8K'"; FLUX.2 guide ships full mm/f tables ("14–24mm wide angle, dramatic perspective"). Generative Photography (arXiv:2412.02168) had to *train* intrinsics consistency — the base models treat mm as style. → On non-photo mediums say "wide field of view taking in the whole square" instead of "24mm" |

## 3. Style-medium × projection (the trap, and the guard)

- The trap is asymmetric: **projection words are also style words.**
  "Isometric" → 3D-render aesthetics; "satellite/nadir/drone" → photorealism;
  "aerial city" → tilt-shift miniature; "plan" → CAD blueprint. Each projection
  needs a medium-preservation rider, and the rider must *re-name the medium*
  (our `medium_lock` already does: "Keep the exact art medium of the reference
  — {anchor} — same palette and line work; NOT a photograph, no photorealism").
- **Grammar trick that does most of the work**: attach the projection to the
  *artwork*, not to a *camera*. "A hand-drawn ink map of the valley, drawn in
  flat plan view" keeps medium; "the valley shot from directly overhead" invites
  a photo. Camera-hardware nouns (lens, mm, drone, GoPro, f/1.8) are exactly
  the photorealism levers the official guides advertise — keep them OUT of
  hand-drawn prompts. fenestra's working architecture prompts model this:
  "draw a 2D elevation … **as a simple drawing** on a white background".
- For isometric specifically, pair the trigger with a flat-art register:
  "isometric **illustration**, flat shading, clean linework, drawn in the same
  ink-and-wash medium — not a glossy 3D render" (IBM isometric-illustration
  register + Grokipedia 2D/3D register split + aituts "clean pixel art" trick).
- Kontext is text-only on style (no style ref) — its rider must both name the
  medium and use the preserve frame: "while preserving the exact hand-drawn
  ink-and-watercolour medium, palette, and line work of the original" (BFL
  style-transfer template: "Convert to [style] while maintaining [elements]").

## 4. Ordering / weighting / emphasis per family

| Family | Placement | Negation | Emphasis/repetition |
|---|---|---|---|
| **Gemini image** (nano-banana, Flash, 3 Pro) | Narrative paragraph; official skeleton [Subject]+[Action]+[Location]+**[Composition]**+[Style] — camera lives in the Composition slot, mid-to-late; Atlabs/NBP guide adds a trailing [Specific Constraint] slot | Positive-first ("empty street" not "no cars") but instruction-style "do not / NO" works in practice (our shipped clauses); it's an LLM-native model that follows instructions | "Be descriptive, not repetitive" — no keyword spam, no '4k masterpiece'; conversational edit turns re-state the one change ("Show this scene from a bird's eye view") |
| **gpt-image** (1 / 1.5 / 2) | Consistent block order: background/scene → subject → key details → **constraints last**; example shows camera early when it defines the shot ("Shot like a 35mm film photograph, medium close-up at eye level, 50mm lens…") | Explicit exclusion lists are *official*: "no watermark", "no extra text"; "change only X" + "keep everything else the same" | **Repeat the preserve list on each iteration to reduce drift** (official); community uses CAPS for the load-bearing face-visibility sentence; weak at re-angling existing content — describe visible faces, not angles |
| **FLUX / Kontext** | Front-load: "FLUX pays more attention to what you mention first" → projection words first; Kontext capped at 512 tokens, keep clauses short | Kontext: preserve-framing beats negation ("Maintain identical subject placement, camera angle, framing, and perspective"); verb semantics matter: transform=whole-image, change=partial, replace=swap | Never ask Kontext to move the camera (subject rotates instead — Civitai "Change Camera Angle" LoRA exists to patch this). Keep Kontext on same-view zoom/edit duty |
| **Seedream 4.x** | Lead with subject; "one thought per sentence"; composition keywords accepted ("overhead perspective", "wide-angle view") | re-angle on edit reportedly strong: "change the camera angle from a head-on shot to a top-down shot … nails the new perspective while maintaining the original style" (mew.design review) | n/a — keep sentences atomic |

Capitalization: no official guide mentions it for any family. It appears in
working community prompts (and ours) as emphasis; treat as free but
evidence-anecdotal. Within a single prompt, one strong clause + one guard
beats triple repetition (Gemini's anti-repetition line); across *edit
iterations*, repetition of invariants is officially recommended (gpt-image).

## 5. Recommended vocabulary (feeds `_PROJECTION_LANGUAGE`)

Principles compiled from the above:

1. Two-part clause per projection: **positive register sentence** (projection
   as a property of the artwork, naming what is visible) + **negative guard**
   (short, explicit, names the two failure attractors).
2. **Medium rider always present** on non-photo styles; it re-names the medium
   and bans the projection's specific drift (3D render for isometric, photoreal
   ortho for top-down, tilt-shift for oblique).
3. Numbers always **bucketed into register words**, emitted as
   "register (≈N°)" — the word carries, the number disambiguates for humans
   and future models.
4. Azimuth: maps get "north at the top"; scenes get relational "looking toward
   {landmark}", with the compass word only as a parenthetical.
5. Per-family deltas are *placement and framing*, not vocabulary: same dict,
   composed front-loaded for FLUX, in-narrative for Gemini, constraints-block
   for gpt-image; Kontext only ever receives the **preserve** form.

The concrete dict candidate is in the wave-1 hand-off (R1 final message) and
should land in `providers/prompt_library/projection.py`.

## Sources

Official / first-party:
- Google Cloud, "Ultimate prompting guide for Nano Banana" — https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana
- Google DeepMind, "How to create effective image prompts with Nano Banana" — https://deepmind.google/models/gemini-image/prompt-guide/
- Google blog, "Nano Banana Pro prompting tips" — https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/
- Gemini API image generation docs — https://ai.google.dev/gemini-api/docs/image-generation
- OpenAI Cookbook, "GPT-Image-1.5 prompting guide" — https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide
- BFL Kontext i2i prompting guide (mirrored; bfl.ml/bfl.ai paths rotate) — https://docs.bfl.ml/guides/prompting_guide_kontext_i2i / https://comfyui-wiki.com/en/tutorial/advanced/image/flux/flux-1-kontext
- LTX, "FLUX.2 prompting guide" — https://ltx.io/blog/flux-prompting-guide

Papers:
- PreciseCam: Precise Camera Control for Text-to-Image Generation — https://arxiv.org/abs/2501.12910
- Camera Control via Learning Viewpoint Tokens — https://arxiv.org/abs/2604.19954
- Generative Photography (camera intrinsics) — https://arxiv.org/abs/2412.02168
- CameraCtrl (video, for the parameterization precedent) — https://arxiv.org/abs/2404.02101

Community / applied:
- OpenAI forum: isometric perspective control — https://community.openai.com/t/does-anyone-know-a-reliable-way-for-controlling-perspective-of-isometric-images-in-gpt-4o-and-image-1/1286840
- OpenAI forum: top-down view failures — https://community.openai.com/t/getting-a-top-down-view-image/1130642
- techyheaven nano-banana-pro camera control — https://techyheaven.com/nano-banana-pro-camera-control/
- imaginewithrashid nano-banana camera-angle prompt set — https://imaginewithrashid.com/gemini-nano-banana-pro-prompts-for-camera-angles/
- Atlabs Nano Banana Pro guide (structure formula) — https://www.atlabs.ai/blog/the-ultimate-nano-banana-pro-prompting-guide-mastering-gemini-3-pro-image
- aituts Midjourney/FLUX isometric prompts — https://aituts.com/midjourney-isometric/
- Civitai "Change Camera Angle" Kontext LoRA (evidence of the subject-rotation failure) — https://civitai.com/models/1883262/change-camera-angle-kontext-lora
- fenestra.app: nano-banana 2D architectural drawings — https://www.fenestra.app/blog/ai-2d-architectural-drawings-nano-banana
- Seedream 4 re-angle review — https://docs.mew.design/blog/seedream-40-review/ ; fal Seedream guide — https://fal.ai/learn/devs/seedream-v4-5-prompt-guide
- Aerial-survey register (nadir vs oblique 45°) — https://www.jouav.com/blog/oblique-imagery.html ; https://www.autelpilot.com/blogs/drone-technology/nadir-orthophotography-oblique ; https://www.flyingglass.com.au/oblique-and-vertical-aerial-photography/
- Graphical projections taxonomy (game art) — https://medium.com/retronator-magazine/game-developers-guide-to-graphical-projections-with-video-game-examples-part-1-introduction-aa3d051c137d
- 3D-render vs 2D-illustration register split — https://grokipedia.com/page/3D_Render_vs_2D_Illustration_in_AI_Prompts
- unimatrixz camera-position vocabulary (no-degrees finding) — https://unimatrixz.com/blog/latent-space-camera-positions/
