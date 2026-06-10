# 10 — View-transform prompting on image-edit endpoints (R3)

Research notes for the view-grammar build (`ViewSpec` + `providers/prompt_library/`).
Question: how to phrase "same place, new camera" on our three edit families so place
identity survives the view change. Date: 2026-06-10.

Empirical baseline from our own eval (docs/research/06/07): nano-banana(-pro/-2)/edit
tolerate big view changes (9.0–9.33/10 same-place), gpt-image edit 8.67/10,
FLUX Kontext 3.33/10 on viewpoint change but ideal for same-viewpoint zoom-continues.
Everything below explains and operationalizes that split.

---

## 1. Cross-family instruction grammar findings

### 1.1 Anchor-first vs transform-first — it differs by family

- **Gemini / nano-banana lineage is a *scene re-describer***: Google's official editing
  templates all open by binding the source image to a named subject — "Using the
  provided image of [subject], please [add/remove/modify]…" and "Using the provided
  image, change only the [element]… Keep everything else in the image exactly the
  same, preserving the original style, lighting, and composition."
  ([Google Developers Blog — How to prompt Gemini 2.5 Flash Image](https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/))
  The same guide's top rule — "Describe the scene, don't just list keywords" — means
  the strongest *large* view changes are phrased as a description of the TARGET view
  anchored to the source, not as a camera-motion command. The canonical proof is the
  viral map→street-view transform: "**draw what the red arrow sees**" / "draw the real
  world view from the red circle in the direction of the arrow" — pure target-state
  description, zero camera vocabulary, and it produces a ground-level view of the same
  map location ([tokumin demo on X](https://x.com/tokumin/status/1960583251460022626),
  reproduced with exact prompts in the
  [img-2-img Nano Banana guide, Case #2](https://www.img-2-img.com/posts/Nano-Banana-Guide)).
  The inverse direction also works: "Convert the photo to a top-down view and mark the
  location of the photographer" (same guide, Case #9, noted "accurate spatial
  transform; preserved landmarks").
- **Small deltas on the nano family DO work as explicit camera commands**: community
  camera-angle guides use "Tilt the camera slightly to the left", "Show the building
  from a higher viewpoint", with riders "maintain object proportions", "preserve
  shadows and lighting" ([glbgpt how-to](https://www.glbgpt.com/hub/how-to-change-photo-angles-and-perspectives-with-nano-banana/),
  [Directing Perspective, R. Granados](https://rosagranados.substack.com/p/directing-perspective-changing-camera)).
  Practitioner consensus: **put the angle/lens vocabulary at the very start of the
  prompt** and remove conflicting descriptors
  ([sider.ai advanced camera angle prompts](https://sider.ai/blog/ai-image/advanced-camera-angle-prompts-for-nano-banana-pro)).
- **gpt-image edit is *change-first + preserve-list***: OpenAI's prompting guide
  prescribes "change only X" + "keep everything else the same", with a 4-part
  structure: (1) what to change, (2) preservation constraints, (3) realism cues,
  (4) technical guards — and to "repeat the preserve list on each iteration to reduce
  drift" ([gpt-image-1.5 prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide)).
  Viewpoint is specified as a *target state* ("framing and viewpoint: close-up, wide,
  top-down; perspective/angle: eye-level, low-angle"), not as motion verbs.
- **Kontext is *verb-first with a preservation tail*, and the verb choice is
  load-bearing**: BFL's official i2i guide warns that "transform" without qualifiers
  signals a COMPLETE change; prefer "change / convert / replace" plus explicit
  "while maintaining the same [composition/lighting/…]" clauses; name subjects
  directly ("the woman with short black hair"), never pronouns; max 512 tokens
  ([BFL Prompting Guide — Image-to-Image](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i),
  mirrored in [Replicate's Kontext post](https://replicate.com/blog/flux-kontext) and
  the [fluxai.pro guide](https://fluxai.pro/blog/flux-kontext-prompt-guide) which
  formalizes it as Action layer → Context layer → Preservation layer).

**Takeaway for the prompt library**: one skeleton shape fits all three — *anchor
sentence (this exact place) → transform sentence (target view, camera terms early) →
invariant list → medium rider → guards* — but the transform sentence's register flips:
target-state re-description for nano/gpt big moves, delta phrasing only for small
nano moves, and for Kontext the transform sentence should be avoided entirely except
zoom/crop (see §5).

### 1.2 Camera deltas vs scene re-description — verdict

| Move size | nano-edit family | gpt-image-2/edit | Kontext |
|---|---|---|---|
| Register change (map→interior, map→isometric) | Target-state re-description ("draw the view from ground level inside…") — proven by red-arrow demo | Target-state + preserve list | Out-of-distribution (§5) — route away |
| Small delta (raise/lower camera, slight orbit, tilt) | Explicit camera delta works ("show from a higher viewpoint") | Target framing words ("top-down", "eye-level") | Subject rotates instead of camera (§4.1) |
| No view change (zoom-continue) | Keep-camera clause ("from the SAME overhead viewpoint") | Same | **In-distribution sweet spot** — keep-camera clause is straight from BFL's own guide |

---

## 2. Multi-reference usage (source + style exemplar)

- **fal nano-banana(-pro/-2)/edit**: `image_urls` is an ordered list; fal documents no
  role semantics ([fal nano-banana-pro/edit API](https://fal.ai/models/fal-ai/nano-banana-pro/edit/api)).
  Role assignment must therefore come from the TEXT.
- **Naming references in text helps — official on both families.** Google (Nano Banana
  Pro tips): "Use Image A for the character's pose, Image B for the art style, and
  Image C for the background environment"
  ([blog.google prompting tips](https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/)).
  Google Cloud's Nano Banana guide gives the formula
  "[Reference images] + [Relationship instruction] + [New scenario]" and the dev-blog
  composition template names elements per image ("Take the [element from image 1] and
  place it with the [element from image 2]")
  ([Ultimate prompting guide for Nano Banana](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)).
  OpenAI: "reference each input by index and description (Image 1: product photo…,
  Image 2: style reference…) and describe how they interact"
  ([gpt-image-1.5 guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide)).
- **Ordering matters on gpt-image**: "the first image in the list preserves the finest
  detail and richest texture" — put the SOURCE (tapped region crop) first, style
  exemplar second ([OpenAI high input fidelity cookbook](https://developers.openai.com/cookbook/examples/generate_images_with_high_input_fidelity)).
  `input_fidelity="high"` exists on gpt-image-1/1.5 for faces/logos; **gpt-image-2
  processes every input at high fidelity automatically** (parameter not settable)
  ([OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation)).
- Reference limits, Gemini family: up to 14 reference images; Gemini 3 Pro Image
  (= nano-banana-pro): up to 6 objects + 5 characters
  ([ai.google.dev image generation docs](https://ai.google.dev/gemini-api/docs/image-generation)).
- Our code already does source-first (`urls = [image_url] + [style_ref_url]` in
  `apps/modal-backend/providers/image_edit.py`) — matches gpt-image's documented
  ordering and the community default for nano (first = base being edited). Action:
  ADD the role-naming sentence ("Image 1 is the map of this place; Image 2 is only a
  style reference — take no content from it") which we currently omit.
- **Kontext takes a singular `image_url` — no second ref.** The style/medium must ride
  in TEXT (our enter builder already documents this: "The medium clause is load-bearing
  when FAL_ENTER_MODEL points at Kontext").

---

## 3. Identity-preservation riders: which invariants, how many

**Which invariants to enumerate** (union of the official lists, mapped to our domain):

| Source guidance | Our world-mode equivalent |
|---|---|
| BFL character framework: establish reference → specify transformation → "preserve identity markers" | Anchor "this exact [place name]" → view change → invariant list |
| Kontext composition control: "maintain identical subject placement, camera angle, framing, and perspective" | Keep-camera clause on zoom-continues |
| gpt-image: face, pose, proportions, background; "preserve identity/geometry/layout/brand elements" | architecture/building shapes, materials, palette, layout |
| Gemini: "preserving the original style, lighting, and composition"; "Do not change any other elements" | medium rider + blanket guard |
| Community view-change riders: "maintain object proportions", "preserve shadows and lighting" | scale sanity on camera-height moves |

For a PLACE (our case) the invariant set that sources support enumerating:
**(1) architecture/structure shapes, (2) materials, (3) color palette, (4) landmark
inventory (named, count-bounded), (5) relative positions/left-right relations,
(6) art medium.** Items 1–3+6 appear verbatim in official guides; 4–5 are our
extension of "identity markers" to places, supported by the red-arrow reproduction
notes ("preserved landmarks" as the success criterion, img-2-img Case #9).

**How many before dilution** — three converging signals:
- BFL: "Making things more explicit never hurts **if the number of instructions per
  edit is not too complicated**" + hard 512-token cap
  ([BFL guide](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)).
- OpenAI: "avoid overloading single prompts… start with a clean base prompt, then
  refine with small, single-change follow-ups"; restate the preserve list each
  iteration rather than growing it
  ([gpt-image-1.5 guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide)).
- Google: iterate conversationally; if consistency drifts over many turns, restart
  ([dev blog](https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)).

**Rule of thumb for the library**: ONE transform per prompt; ≤6 named invariants +
≤8 named landmarks (our existing `facts[:8]` cap in the enter builder agrees);
one medium rider; ≤2 negative guards. Beyond that, prefer a second edit round over a
longer prompt.

---

## 4. Failure modes and documented mitigations

### 4.1 Camera command rotates the SUBJECT, not the camera (Kontext)
Documented as the motivating flaw of the ChangeAngle LoRA: base Kontext "rotates the
main subject instead of moving the camera around it, leaving the background
untouched" ([Civitai — Change Camera Angle Kontext LoRA v2](https://civitai.com/models/1883262/change-camera-angle-kontext-lora)).
Mitigation in ecosystem = train a LoRA (trigger `ChangeAngle, tilt camera slightly
down, pan camera left, zoom-out`). Mitigation for us = **don't send view changes to
Kontext** (matches our 3.33/10).

### 4.2 Left/right mirror confusion on orbits (all families, worst on Kontext)
"The model occasionally reverses directional cues… correct orientation usually
achieved after a few generations" (Civitai LoRA notes). Mitigation: express direction
**landmark-relative**, not camera-relative — "facing the gatehouse, with the tower on
the left of frame" rather than "pan left"; allow one retry.

### 4.3 Identity loss on large rotations / radical viewpoint changes
Community guides warn to "avoid extreme angles that distort unless intentional" and
that radical shifts strain identity ([glbgpt](https://www.glbgpt.com/hub/how-to-change-photo-angles-and-perspectives-with-nano-banana/));
the GPT-4o empirical study evaluates novel-view synthesis among its 20+ tasks and finds
style/structure consistency varies sharply by model
([arXiv 2504.05979](https://arxiv.org/abs/2504.05979)); NVS evaluation work shows
pixel metrics mis-rank such outputs, i.e. failures are common enough to need dedicated
metrics ([arXiv 2511.12675](https://arxiv.org/abs/2511.12675)). Mitigations:
anchor-first phrasing + enumerated landmark inventory (§3); keep per-step azimuth
change ≤~90° and chain steps for bigger orbits (Civitai LoRA usage pattern:
sequences of small moves); on nano, restate invariants and retry rather than pile on
more text.

### 4.4 Medium drift toward photorealism / "3D render" on isometric asks
The popular isometric prompt register is "isometric 3D render", so the word
"isometric" alone pulls toward glossy CG; guides counter with constraint-first
phrasing: "isometric 3D, **parallel edges, no perspective**" plus explicit style
terms ([CapCut isometric guide](https://www.capcut.com/ideas/ai-image/ai-image-for-isometric-illustrations)).
Google's fix for unwanted change is semantic positive framing + explicit preservation
("Preserve the original composition… render it with [stylistic elements]" — style
transfer template). Mitigation: medium rider IMMEDIATELY adjacent to the projection
words — "isometric **illustration** in the exact art medium of the source — NOT a
photorealistic 3D render" — and never use the bare token "3D". (Consistent with our
style medium-lock findings, PR #15.)

### 4.5 Scale hallucination when changing camera height / zooming out
There is no precise zoom control: "you can't tell it 'zoom out 10×'; results vary"
([MyAIForce Flux layout control](https://myaiforce.com/flux-prompting-and-anti-blur-lora/)).
Naive "zoom out" gets reinterpreted as subject rescale. The documented fix is
**outpaint semantics**: "Zoom out and keep the visible subject exactly the same in
position, scale and appearance. Expand the canvas evenly in every direction and fill
all new areas with a natural continuation of the scene, matching the original
lighting, perspective and photographic style"
([flux-kontext-zoom-out-lora, HF](https://huggingface.co/reverentelusarca/flux-kontext-zoom-out-lora)) —
i.e., the camera "takes a few steps back" by pushing the original deeper into the
canvas ([PirateDiffusion outpainting](https://piratediffusion.com/stable-diffusion-how-to-outpaint/),
[Midjourney Zoom Out docs](https://docs.midjourney.com/hc/en-us/articles/32595476770957-Zoom-Out)).
For camera-HEIGHT moves, give a concrete anchor + proportion rider: "from rooftop
height, about 20 m up… maintain object proportions" (glbgpt/sider riders). Our
geometric world model can supply the number (`camera_height`), which sources say to
state rather than imply.

### 4.6 Aspect-ratio drift
Gemini family "generally preserves the input image's aspect ratio when editing,
but be explicit if needed: 'Do not change the input aspect ratio'"
([Google dev blog](https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)).
fal exposes `aspect_ratio` (default `auto`) — set it from the wire, keep the text
guard for Gemini-family enters.

### 4.7 Iterative drift across turns
OpenAI: restate the preserve list every iteration. Google: restart the conversation
when character consistency degrades. For us: every revisit/regenerate must re-send the
FULL invariant block, never a diff.

---

## 5. Kontext verdict: strict-edit register, viewpoint change is out-of-grammar

- BFL's official guide teaches preservation-heavy editing: "while maintaining the same
  [facial features/composition/lighting]", and — decisive for us — its only CAMERA
  guidance is to **keep** it: "specify 'keep the exact camera angle, position, and
  framing' to prevent unwanted repositioning"; the flagship example is a background
  swap with "Maintain identical subject placement, camera angle, framing, and
  perspective" ([BFL guide](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)).
  Nowhere does the official material show a viewpoint-change prompt.
- The community treats camera moves as a missing capability to be patched by LoRAs
  (ChangeAngle for orbits/tilts, zoom-out LoRA for pullbacks) — strong confirmation
  that view transforms are out-of-distribution for the base editor, matching our
  3.33/10 same-place score on view change vs its strength on zoom-continues.
- **Confirmed recommendation**: Kontext serves `zoom-continue` (same viewpoint,
  in-distribution: "zoom into…", crops, "closeup shot of" composition words) and
  identity-strict restyles; `enter` and large `outward` go to nano-edit or
  gpt-image-2/edit. If a Kontext view change is ever forced (single-ref fallback),
  phrase it scene-level ("the view from inside the courtyard of this exact castle")
  not camera-level, keep the full medium rider in text (no style ref slot), and
  expect degraded identity.
- Kontext-specific limits to encode: 512-token prompt cap; very tight crops "can warp
  badly"; complex scenes risk background over-modification on any non-local edit.

---

## 6. Recommended skeletons (per family × operation)

Shared shape: **[1 anchor] → [2 transform] → [3 invariants] → [4 medium rider] →
[5 guards]**. `{...}` slots come from ViewSpec + the geometric world model;
`SCENE LAYOUT` is our proven projection clause (+0.33 layout fidelity) appended last.
The full copy-paste variants are in the build hand-off (R3 final response); the
per-family deltas:

| Op | nano-edit family | gpt-image-2/edit | Kontext |
|---|---|---|---|
| enter eye_level | Anchor-first target-state: "Using the provided map image (Image 1): step inside this exact {place} and draw what a person standing there sees, eye level, ~1.6 m…" | Change-first: "Change only the camera: from overhead map to eye level inside {place}… Preserve: [list]" | Not recommended (route away); fallback scene-level phrasing |
| enter oblique/isometric | "…now seen as an isometric illustration: three-quarter view from the {SE}, parallel edges, no perspective convergence, camera pitched ~{35}°…" + medium rider adjacent | Same target-state + preserve list + "no photorealistic 3D render" | Not recommended |
| zoom-continue top_down | Keep-camera: "zoom into {region}… from the SAME overhead top-down viewpoint, camera straight down; do not switch to eye level or 3/4 view. Keep everything else exactly the same…" | Same + index naming | **Native**: "Zoom into {region} of this map while maintaining the exact same overhead camera angle, position and framing; preserve all existing structures, palette and linework" |
| outward / zoom-out | Outpaint semantics: "keep the visible map exactly the same in position, scale and appearance; expand the canvas… continue the same terrain/style outward to reveal {parent}" | Same, change-first | zoom-out LoRA skeleton verbatim (works partially on base); prefer BRIA expand for pure outpaint |

---

## 7. Sources

Official:
- BFL, [Prompting Guide — Image-to-Image (Kontext)](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Google, [How to prompt Gemini 2.5 Flash Image](https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)
- Google Cloud, [Ultimate prompting guide for Nano Banana](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)
- Google, [Nano Banana Pro prompting tips](https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/) · [Gemini image docs](https://ai.google.dev/gemini-api/docs/image-generation)
- OpenAI, [gpt-image-1.5 prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide) · [high input fidelity cookbook](https://developers.openai.com/cookbook/examples/generate_images_with_high_input_fidelity) · [image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- fal, [nano-banana-pro/edit API](https://fal.ai/models/fal-ai/nano-banana-pro/edit/api) · [flux-pro/kontext](https://fal.ai/models/fal-ai/flux-pro/kontext)

Community / empirical:
- [tokumin red-arrow map transforms](https://x.com/tokumin/status/1960583251460022626) · [img-2-img Nano Banana guide](https://www.img-2-img.com/posts/Nano-Banana-Guide)
- [Civitai ChangeAngle Kontext LoRA v2](https://civitai.com/models/1883262/change-camera-angle-kontext-lora) · [flux-kontext-zoom-out-lora](https://huggingface.co/reverentelusarca/flux-kontext-zoom-out-lora)
- [Replicate Kontext blog](https://replicate.com/blog/flux-kontext) · [fluxai.pro Kontext guide](https://fluxai.pro/blog/flux-kontext-prompt-guide) · [MyAIForce Flux layout](https://myaiforce.com/flux-prompting-and-anti-blur-lora/)
- [glbgpt angle changes](https://www.glbgpt.com/hub/how-to-change-photo-angles-and-perspectives-with-nano-banana/) · [Directing Perspective (Granados)](https://rosagranados.substack.com/p/directing-perspective-changing-camera) · [sider.ai camera prompts](https://sider.ai/blog/ai-image/advanced-camera-angle-prompts-for-nano-banana-pro)
- [CapCut isometric guide](https://www.capcut.com/ideas/ai-image/ai-image-for-isometric-illustrations) · [PirateDiffusion outpainting](https://piratediffusion.com/stable-diffusion-how-to-outpaint/) · [Midjourney Zoom Out](https://docs.midjourney.com/hc/en-us/articles/32595476770957-Zoom-Out)

Papers:
- [arXiv 2504.05979 — Empirical Study of GPT-4o Image Generation](https://arxiv.org/abs/2504.05979) (NVS among 20+ tasks)
- [arXiv 2511.12675 — Task-Aware Evaluation for NVS](https://arxiv.org/abs/2511.12675) (pixel metrics mis-rank view-change outputs)
