# 09 — Spatial/metric language: what placement prompts current image models actually honor

_Research-grounded (web, June 2026). Companion to `02-prompting.md` and `03-coordinate-injection.md`.
Our baseline: `geometry_prompt.layout_constraints` ("SCENE LAYOUT (place these exactly where stated —
nearest listed first…): Label — size, h_pos v_pos; …") measurably lifts layout fidelity **+0.33** on a
0–10 judge. This doc asks what *more* spatial language the models will honor — heights, depth layers,
bearings, distances — and at what granularity, with sources. Extension specs at the end._

## TL;DR table

| Spatial channel | Honored? | Best phrasing | Worst phrasing |
|---|---|---|---|
| Coarse screen bins ("upper left", "far-right") | ✅ best-in-class | named regions, extremes ("far left") | mild/ambiguous ("near", "beside") |
| Percentages / pixel coords / grid refs in prose | ❌ weak everywhere | — | "at 30% from the left", "cell B2" |
| Relational, camera frame ("on the viewer's left") | ✅ strongest frame | explicit "viewer's/camera" | bare "left of X" (frame-ambiguous) |
| Relational, object frame ("to the chair's left") | ❌ flips L/R | avoid, or convert to camera frame | any allocentric phrasing |
| Cardinal on a **north-up-pinned map** | ✅ (becomes screen dirs) | "North is at the top. A lies north of B" | cardinal without pinning the frame |
| Absolute metric ("12 m tall", "5 m apart") | ❌ ignored | — | any meters/feet in prompt |
| Relative size/height ("5× the height of") | ⚠️ partial, best size signal we have | one shared anchor entity | pairwise meshes, exact ratios |
| Depth order ("in front of / behind / hidden by") | ✅ better than 2-D left/right | fg/mg/bg layer lists, occlusion pairs | unordered scatter of "behind" pairs |
| Count of constraints | degrades past ~6–8 | grouped layers, labeled segments | 10+ flat per-entity lines |

---

## 1. Position language: bins beat numbers, frames matter more than words

**The benchmark picture.** 2-D spatial relations are the *hardest* compositional category for every
generation of model. [T2I-CompBench / T2I-CompBench++ (arXiv 2307.06350)](https://arxiv.org/html/2307.06350v3)
tests "on the left of / right of / top of / bottom of / next to / near" with a detector-based metric and
finds 2-D spatial "the most challenging sub-category" — SDXL 0.213, DALL-E 3 0.287, FLUX.1 0.286 (vs
0.5–0.8 for color/shape). [VISOR (arXiv 2212.10015)](https://arxiv.org/abs/2212.10015) found the same a
generation earlier (DALL-E v2 VISOR-4 = 8.5%: even when models *can* place a pair, they don't do it
consistently across seeds). Root cause per [SPRIGHT (arXiv 2404.01197)](https://arxiv.org/html/2404.01197v2):
spatial words are nearly absent from training captions (< 1% of COCO/LAION captions contain
"left"/"right"/"above"/"below"), so spatial phrasing is out-of-distribution; retraining with ~27%-spatial
captions lifts VISOR object-accuracy from 47.8→60.7%. Takeaway for us: spatial clauses work, but they are
fighting caption statistics — keep them short, conventional, and redundant with composition language the
captions *do* contain ("in the foreground", "center-framed", "top-left corner").

**Coarse bins / named regions are what vendors themselves recommend.** OpenAI's
[GPT-Image prompting cookbook](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide)
says to "call out placement explicitly" with named anchors — "logo top-right", "subject centered with
negative space on left" — and to use short labeled segments with line breaks for complex requests.
[fal's GPT-Image-2 guide](https://fal.ai/learn/tools/prompting-gpt-image-2) (our production model) does the
same: "Product on the right, headline on the left", "subtle player hand in the lower right" — compositional
descriptors, never coordinates. Google's
[Gemini 2.5 Flash Image prompting post](https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)
and the [Nano Banana prompting guide (Google Cloud)](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)
push narrative scene description + photographic composition terms ("center-framed", "medium-full shot",
"aerial view", "low angle") and give **no** coordinate/percentage mechanism at all. Same for
[BFL's FLUX prompting guide](https://docs.bfl.ml/guides/prompting_summary): "natural language that reads like
a clear image description", no coordinate vocabulary.

**Percentages, pixel coordinates and grid references in prose: no evidence of adherence, plenty against.**
The layout-control literature that *wanted* numeric placement always routed numbers around the text
encoder: [LayoutGPT](https://arxiv.org/abs/2305.15393) emits CSS-style numeric layouts but renders them
with GLIGEN (a layout-conditioned generator), and
[Control-GPT (arXiv 2305.18583)](https://arxiv.org/pdf/2305.18583) measures "fine-grained control on object
sizes and positions specified in text" as weak and fixes it by having GPT-4 draw TikZ *sketches* as image
conditioning — not by better prose. On the multimodal-LLM side, text-form coordinates are weakly grounded
even for *understanding*: [Roboflow's GPT-4V experiments](https://blog.roboflow.com/gpt-4v-object-detection/)
and [Tenyks' SAM2+GPT-4o study](https://www.edge-ai-vision.com/2025/02/sam-2-gpt-4o-cascading-foundation-models-via-visual-prompting-part-2/)
found raw numeric boxes in text nearly useless (drawn boxes on the image work). Our own conclusion in
`03-coordinate-injection.md` — send bin words, keep continuous rects for the grounding check — is exactly
what this literature predicts. **Verdict: keep the 5×3 bin vocabulary (`far-left…far-right` × `top/mid/bottom`); do not ship percentages or grid refs in prompt text.**

**Phrase at the extremes; avoid mid/ambiguous placements.**
["Why Settle for Mid" (arXiv 2506.23418)](https://arxiv.org/html/2506.23418) shows models interpret
relations probabilistically with a strong central tendency: clearly-separated directional language ("to the
far left") aligns far better than mild displacement, and composite directions ("top-left") work as combined
axes. Our `far-left/far-right` extreme bins are an asset — prefer them over post-hoc nudging. Negated
spatial relations ("not to the left") essentially never work ([SPRIGHT](https://arxiv.org/html/2404.01197v2)) —
never emit "don't place X near Y"; restate positively.

**The reference frame is the single biggest lever.**
[GenSpace (arXiv 2505.24870)](https://arxiv.org/html/2505.24870v2) — the closest thing to a definitive
spatial-generation eval, covering GPT-4o (53.2% overall), Gemini-2.0-Flash (47.7%), Seedream-3.0 (52.0%),
FLUX.1-dev (38.0%), SD3.5-L (34.1%) — splits relations into **egocentric** (camera frame), **allocentric**
(another object's frame) and **intrinsic** (view-independent, "side by side"). GPT-4o: **94.6% egocentric vs
21.2% allocentric vs 19.1% intrinsic** — models "often reverse the left/right condition" when the frame is
another object's. So "on the viewer's left" is near-solved; "to the left of the fountain (as the fountain
faces)" is a coin flip. All our generated spatial text must be **camera-frame screen language**, which is
what the projection engine already produces.

## 2. Size and scale: relative comparatives only — metric units are dead on arrival

[GenSpace](https://arxiv.org/html/2505.24870v2)'s Spatial Measurement axis is blunt: object size ~30.5%,
object distance ~41.3%, camera distance ~35.2% adherence, and — the killer quote — *"specifying different
measurements has little effect on final generated results."* Absolute meters/feet in prompts are noise.
[VPEval (NeurIPS 2023)](https://proceedings.neurips.cc/paper_files/paper/2023/file/13250eb13871b3c2c0a0667b54bad165-Paper-Conference.pdf)
likewise lists Scale (bigger/smaller pairs) among the still-failing skills, though comparatives score above
chance — relative size is *partially* honored where absolute size is not. Practitioner guides agree by
omission: every vendor guide expresses scale through camera/lens language ("wide-angle to show vast scale",
"macro for details" — [Google Cloud Nano Banana guide](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana))
or through comparatives, never units.

What this means for us: keep meters inside the geometry engine (they drive the projection); at the prompt
boundary emit (a) the existing per-entity **size bins** (tiny…huge — these are *projected screen* sizes, the
thing the model can actually verify against the frame), plus (b) a small number of **relative height
comparatives against one shared anchor** ("the Tower rises about five times the height of a cottage").
One anchor, not a pairwise mesh: every extra comparison is another constraint competing for the same
limited adherence budget (§5). Round ratios aggressively ("about twice", "about 5×") — GenSpace shows the
model can't tell 3 m from 5 m anyway; the comparative's job is to set *ordinal* scale, and exact-looking
numbers just spend tokens. Footprint shapes ("L-shaped hall", "round keep") are object attributes, not
spatial constraints — they bind well (attribute-binding is the *easy* T2I-CompBench category) and can ride
inside the entity description.

## 3. Depth layering: the best-honored spatial axis we're under-using

Two independent lines say depth words outperform left/right words:

- [T2I-CompBench++](https://arxiv.org/html/2307.06350v3) 3-D spatial ("in front of", "behind", "hidden by")
  scores **0.357–0.387** for SDXL/DALL-E 3/FLUX.1 vs **0.213–0.287** for 2-D spatial — the occlusion
  vocabulary including "hidden by" is literally a tested, better-performing phrasing.
- [BFL's FLUX guide](https://docs.bfl.ml/guides/prompting_summary) makes layering the *headline* spatial
  control: describe the scene "in an organized, hierarchical manner" — foreground, then middle ground, then
  background, each layer's contents named together; "explicitly state that object A should be in the front
  and object B behind it"; "visible through" for see-through occlusion.

Our clause already says "nearest listed first … front-to-back order", but it never *names the layers* — the
model has to infer layering from list order. Grouping entities into explicit
**foreground / midground / background** lists (the exact vocabulary in vendor guides and training captions)
both matches the strongest-performing depth phrasing and *compresses* N per-entity facts into ≤3 chunks,
which buys back constraint budget (§5). Occlusion pairs ("the mill is partially hidden behind the granary")
should be emitted only when projected rects actually overlap — we have the rects; an occlusion claim about
non-overlapping entities is a constraint the model must *violate* something to satisfy.

## 4. Bearings and orientation: pin the frame, then cardinal language becomes free

**Maps (top-down register).** Cartographic convention is north-at-top; map readers — and, by training-data
statistics, map-trained models — assume it unless told otherwise
([Ordnance Survey cartography guide](https://docs.os.uk/more-than-maps/geographic-data-visualisation/guide-to-cartography/north-arrows)).
[FRIEDA (arXiv 2512.08016)](https://arxiv.org/pdf/2512.08016) notes north arrows do *not* always point up in
the wild, which is exactly why the frame must be pinned in text. Once you write **"North is at the top of
the map"**, every cardinal relation collapses into a screen relation ("north of the market" ≡ "above the
market") — i.e., cardinal language on a pinned map is just our reliable bin language wearing a cartography
costume, and it keeps the map register that
[generative-cartography work](https://arxiv.org/pdf/2508.18959) and fantasy-map prompting practice say
strengthens the style ("detailed compass rose" is a stock cue in map prompts). A compass rose is good
register *furniture*; do not rely on the rendered rose's needle being correct — the text pin is the
authority, the rose is decoration placed like any other entity ("compass rose, small, far-left bottom").

**Perspective views (eye-level/oblique).** Raw compass bearings in a perspective scene are allocentric →
the ~21% bucket ([GenSpace](https://arxiv.org/html/2505.24870v2)). Convert bearings to **observer-relative
screen language** before prompting: bearing−gaze ⇒ "directly ahead / ahead and to the viewer's left /
to the viewer's far right", depth ⇒ "close by / in the middle distance / far in the distance". Say
*"the viewer's left"*, not bare "left", to kill the frame ambiguity that flips L/R. GenSpace also finds
camera-pose prompts ("view from above", "from behind") sit at only ~53–63% even for GPT-4o and collapse to
~25% in multi-object scenes — so the ViewSpec's projection sentence should *also* be expressed as scene
description ("the camera looks north-east across the square") rather than trusted as a lone pose
instruction. Note this clause family is mostly for **enters and fresh-gens where no projected layout
exists**; when a SCENE LAYOUT clause already places an entity, an observer-relative bearing for the same
entity is redundant spend (the projection already folded the bearing into h_pos).

## 5. List shape: how many constraints, in what order, in what syntax

**Capacity.** Hard numbers on degradation:
- Exact-placement success collapses with object count: FLUX 0.655 (one object) → 0.103 (two) → 0.034
  (three) on [FineGRAIN](https://arxiv.org/pdf/2512.02161)-style per-object specs; GenEval counting:
  FLUX-dev 0.74 / SD3 0.72 / DALL-E 3 0.47 ([GenEval](https://arxiv.org/pdf/2310.11513), small counts only).
- [GenSpace](https://arxiv.org/html/2505.24870v2): spatial accuracy "drops significantly to ~25%" in complex
  multi-object scenes, across all models.
- [DPG-Bench / ELLA (arXiv 2403.05135)](https://arxiv.org/abs/2403.05135): dense many-object/attribute
  prompts are the canonical stress case; models with LLM/native text towers (our whole production set —
  Gemini-native, GPT-image, T5-FLUX) degrade slower than CLIP-era models but still degrade.
- [Prompt Reinjection (arXiv 2602.06886)](https://arxiv.org/pdf/2602.06886): MM-DiT models progressively
  *forget* later prompt content ("prompt forgetting") — position in the prompt is a resource.
- Counterweight: the Gemini 3 family is explicitly marketed on dense structured output — Nano Banana Pro
  does infographics/diagrams with many labeled parts, blends 6–14 reference images, holds 5 people
  consistent ([Google blog](https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/)) —
  and `02-prompting.md` already cites ~91%/94% MUST/MUST-NOT compliance for structured Gemini-3-Pro-Image
  prompting [SCHEMA, arXiv 2602.18903]. Pro-tier capacity is real but not unlimited.

**Practical cap:** keep ≤ **6 per-entity placement lines** on fast tier (nano-banana, FLUX-class) and ≤ **8–10**
on pro tier (nano-banana-pro, gpt-image-2), and cap *total* spatial assertions (placement lines + height
comparatives + occlusion pairs + bearing lines) around **12**. Beyond budget, don't drop entities — *group*
them: a depth-layer line ("background — the hills, the watchtower, the tree line") places three entities for
the cost of one constraint, in the phrasing depth-language evidence favors (§3).

**Ordering.** Three converging findings: first-mentioned concepts dominate generation (order-swap studies,
[A Cat Is A Cat, arXiv 2410.00321](https://arxiv.org/pdf/2410.00321); concept-blending order asymmetries,
[arXiv 2506.23630](https://arxiv.org/pdf/2506.23630)); later prompt content is forgotten first
([Prompt Reinjection](https://arxiv.org/pdf/2602.06886)); and FLUX's official guide wants foreground →
middle → background narration. Our **nearest-first** ordering satisfies all three at once (foreground =
nearest = first = most-attended) — keep it, and within a depth tie put the keystone/anchor entity first.
Clause-level order: SCENE LAYOUT → DEPTH LAYERS → RELATIVE HEIGHTS → BEARINGS, with the whole spatial block
*before* long style boilerplate (medium-lock already brackets front+back per `02-prompting.md`, which is
compatible: medium sentence first, spatial block second, style lock last).

**Syntax.** No source supports JSON-in-prompt for spatial fidelity on our models; vendor guidance is
uniformly natural-language with **labeled sections / line breaks** for complex prompts (OpenAI cookbook,
fal GPT-Image-2 guide), narrative prose for Gemini ([Google developers blog](https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)),
hierarchical prose for FLUX. Our "HEADER (parenthetical rule): item; item." shape is exactly this — keep it
for the new clauses. Semicolon-joined noun phrases, em-dash attribute attachment, one header per channel.

## 6. What we should change

1. **Keep** the 5×3×5 bin vocabulary and nearest-first ordering — they are the literature's best practice
   already. Do not add percentages, pixels, or grid refs to prompt text (keep continuous rects only for the
   grounding diff).
2. **Add a DEPTH LAYERS clause** (fg/mg/bg grouping from per-entity `depth`) — best-honored spatial axis,
   compresses constraint count; plus occlusion pairs gated on actual rect overlap. (Spec below.)
3. **Add a RELATIVE HEIGHTS clause** — one shared anchor entity, coarse ratios, words not meters; never emit
   absolute units in prompts. (Spec below.)
4. **Add a BEARINGS clause with two registers** — top-down: pin "North is at the top of the map", then
   cardinal relations (+ optional compass-rose furniture entity); perspective: observer-relative
   "viewer's left/ahead/far right" + verbal distance, derived from bearing−gaze and depth; suppress
   per-entity bearings already covered by a layout line. (Spec below.)
5. **Enforce a constraint budget in `layout_constraints`**: ≤6 placement lines fast tier / ≤10 pro tier,
   ≤12 spatial assertions total; overflow handled by folding the farthest entities into a single
   background-layer line rather than truncating.
6. **Phrase positives only** (no spatial negation), prefer extreme bins when the projection is near a bin
   edge, and say "the viewer's left" (never bare "left of X") in perspective registers.
7. **ViewSpec hook:** express the camera as scene narration ("seen from directly overhead, map-style" /
   "at eye level from the square, looking north-east") *and* keep per-projection vocabulary in
   `_PROJECTION_LANGUAGE` — camera-pose-only instructions sit at ~53–63% adherence even on the best models.

## Sources

- T2I-CompBench / ++: https://arxiv.org/html/2307.06350v3 (also NeurIPS'23 paper PDF)
- VISOR: https://arxiv.org/abs/2212.10015 (Microsoft Research PDF)
- SPRIGHT "Getting it Right": https://arxiv.org/html/2404.01197v2
- GenSpace: https://arxiv.org/html/2505.24870v2
- Why Settle for Mid: https://arxiv.org/html/2506.23418
- GenEval: https://arxiv.org/pdf/2310.11513 · GenEval 2: https://arxiv.org/html/2512.16853v1
- FineGRAIN failure modes: https://arxiv.org/pdf/2512.02161
- ELLA / DPG-Bench: https://arxiv.org/abs/2403.05135
- Prompt Reinjection (prompt forgetting in MM-DiT): https://arxiv.org/pdf/2602.06886
- A Cat Is A Cat (order effects): https://arxiv.org/pdf/2410.00321 · Concept blending order: https://arxiv.org/pdf/2506.23630
- Control-GPT: https://arxiv.org/pdf/2305.18583 · LayoutGPT: https://arxiv.org/abs/2305.15393
- VPEval: https://proceedings.neurips.cc/paper_files/paper/2023/file/13250eb13871b3c2c0a0667b54bad165-Paper-Conference.pdf
- Text-coordinate grounding weakness: https://blog.roboflow.com/gpt-4v-object-detection/ · https://www.edge-ai-vision.com/2025/02/sam-2-gpt-4o-cascading-foundation-models-via-visual-prompting-part-2/
- Gemini 2.5 Flash Image prompting (official): https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/
- Nano Banana ultimate guide (Google Cloud, official): https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana
- Nano Banana Pro tips (official): https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/
- FLUX prompting guide (BFL, official): https://docs.bfl.ml/guides/prompting_summary
- OpenAI GPT-Image prompting cookbook: https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- fal GPT-Image-2 guide: https://fal.ai/learn/tools/prompting-gpt-image-2
- OS cartography (north arrows): https://docs.os.uk/more-than-maps/geographic-data-visualisation/guide-to-cartography/north-arrows
- FRIEDA cartographic reasoning: https://arxiv.org/pdf/2512.08016 · Generative AI in map-making: https://arxiv.org/pdf/2508.18959
