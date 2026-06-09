# 01 — Model bakeoff: the right model per task

_Code-grounded, honest. Builds on the prior verdict in `docs/SESSION_AUDIT.md:34-39` and the
per-op router in `providers/model_router.py`. Each task = the model the code uses today, whether
its reference-image support is real or a no-op, and a keep/change recommendation. Ends with a
~$25 paid run designed to confirm or refute each call._

## How the code wires models (today)

Two registries, both tier-keyed (`fast`/`balanced`/`pro`), both overridable per-env and
per-request:

- **Generate** (`providers/image.py:29-33`): fast=`nano-banana`, balanced=`nano-banana-pro`,
  pro=`seedream/v4/text-to-image`. Default tier `balanced` (`image.py:39`).
- **Edit** (`providers/image_edit.py:29-33`): fast=`nano-banana/edit`, balanced=`nano-banana-pro`,
  pro=`flux-pro/kontext`. Default `balanced` (`image_edit.py:39`).
- **Per-op overrides** (`model_router.py:19-29`): `zoom_continue`→`flux-pro/kontext`,
  `outpaint`/`outpaint_zoomout`→`bria/expand`, `inpaint`→`flux-pro/v1/fill`,
  `upscale`→`clarity-upscaler`. `fresh`/`scale_parent_fresh` are tier-based (no slug).

The op is chosen purely in `select_operation` (`model_router.py:48-65`): `place_submap` + a region
crop → `zoom_continue`; everything else → `fresh`.

## The reference-image reality (the load-bearing distinction)

The prior finding holds and the current fal docs **sharpen** it: it is the **text-to-image
endpoint** that ignores `image_urls`, not the model family.

- `_args_for` (`image.py:109-134`) only attaches `image_urls` for `nano-banana` slugs, and the
  inline comment records the empirical no-op (a photoreal prompt + an engraving ref came back
  photoreal). fal's own nano-banana-pro **text-to-image** page lists no `image_urls` input;
  the **`/edit`** page lists `image_urls` (up to 14 refs, identity for up to 5 people) plus
  `num_images`/`resolution`. [fal nano-banana-pro/edit]
- So the no-op is structural: fresh-gen + the expand bloom (`generate.py:578-579`, `:736-741`)
  call `generate_image` (text-to-image) → refs are accept-but-ignored; only the **MEDIUM-LOCK
  text** (`llm.py:1131-1143`) holds style there. This matches `SESSION_AUDIT.md:34-39,125-127`.
- Refs **do** bite on the edit/continue endpoints: `nano-banana(-pro)` edit takes `image_urls`
  (`image_edit.py:62-64`), Kontext takes a singular `image_url` (`image_edit.py:67-68`).
- **Literature why:** loose cross-attention reference conditioning (IP-Adapter style) gives only
  weak identity/style adherence vs. fine-tuning; spatial/structure control needs a separate
  signal. [IP-Adapter docs; Mercity] The text-to-image nano refs behave like weak IP-Adapter
  conditioning at best; the edit endpoints concatenate the image into context (Kontext's
  "sequence concatenation" [Kontext arXiv 2506.15742]) which is why they actually preserve it.

## Per-task recommendations

### 1. Fresh map render (`fresh`, tier-based)
- **Today:** `nano-banana-pro` (balanced). Strong text-following, good label legibility at
  2K/4K, no spatial-control inputs (natural language only). [fal nano-banana-pro/edit;
  DeepMind prompt guide]
- **Ref support:** **no-op** (text-to-image). Style rides MEDIUM-LOCK text.
- **Limit:** the `FAL_IMAGE_MODEL=nano-banana` (non-pro) env pin garbles map labels
  (memory `project_fal_model_pin`); keep balanced=`nano-banana-pro` for clean text.
- **Recommendation:** **keep nano-banana-pro.** Stop uploading the inert fresh-gen ref
  (`SESSION_AUDIT.md:87`) — pure wasted fal upload. seedream (pro tier) is a viable text-to-image
  alternative but buys nothing for the map case and has weaker label text.

### 2. Zoom-continue / DEEPER (`zoom_continue` → `flux-pro/kontext`)
- **Today:** Kontext, singular-ref in-context edit, "closer faithful continuation of this exact
  map" (`image_edit.py:113-152`). The bakeoff picked it for strict zoom that keeps content +
  style + layout vs. nano-banana's loose refs.
- **Ref support:** **real** but singular (`image_url`) — so it carries **no separate style
  exemplar** (`SESSION_AUDIT.md:99`); the medium clause rides the instruction text. Kontext is
  purpose-built for identity/composition preservation across iterative edits.
  [Kontext arXiv 2506.15742; together.ai]
- **Limit:** renders label text as garble — the code deliberately works named features in as
  *things to draw*, not captions (`image_edit.py:141-149`), and asks for sparse legible lettering.
- **Recommendation:** **keep Kontext.** Open question to settle in the paid run: does
  nano-banana-pro **/edit** (which *can* take a 2nd style ref + does multi-image) now match
  Kontext on faithful zoom? If yes, the default-tier edit model and zoom could unify on one slug
  and regain the style exemplar.

### 3. Outpaint / AROUND map-pan (`outpaint`/`outpaint_zoomout` → `bria/expand`)
- **Today:** BRIA Expand — pixel-preserving outpaint; the parent keeps its pixels, the margin is
  painted to match (`image_edit.py:188-294`). Directional pin for map-pan (`_expand_args_for`),
  centered canvas for OUTWARD zoom-out (`_zoomout_args_for`).
- **Ref support:** N/A (it's an outpaint, not a ref-conditioned gen). Critical gotcha the code
  already handles: BRIA's `prompt` is **optional and auto-generated from the image when empty**,
  which fills photorealistically — so a hand-drawn map drifts to a photo in the margin.
  [fal bria/expand; Bria docs] The code **must** pass the medium in `prompt`
  (`image_edit.py:308-330`, `generate.py:557-565`).
- **Limit:** the centered zoom-out leaves a soft seam at the source rectangle
  (`image_edit.py:316-319`); the seamless OUTWARD default is instead the fresh `scale_parent`
  gen (`generate.py:542-548`).
- **Recommendation:** **keep BRIA** for directional map-pan (its core strength). For OUTWARD,
  the code already prefers fresh `scale_parent` over the seamed outpaint — correct.

### 4. OUTWARD container synth (`scale_parent_fresh`, tier-based + ref)
- **Today:** text-to-image fresh gen with the source passed as `reference_urls=[body.image]`
  (`generate.py:578-579`) — but per §"ref reality" that ref is a **no-op**; only the
  `scale_parent` style-anchored prompt (`llm.plan_page(..., render_mode="scale_parent")`,
  `generate.py:569-577`) holds the look. Used for medium-flip hops (planet→star_system) where an
  outpaint can't reframe (`model_router.py:83-103`).
- **Ref support:** **no-op** (text-to-image path) — this is the riskiest path for style drift.
- **Recommendation:** **change.** Either (a) route `scale_parent_fresh` through the **edit**
  endpoint (nano-banana-pro/edit, which honors refs + identity), or (b) accept text-only and
  drop the inert ref. The paid run should measure style-drift on this hop specifically.

### 5. Entity-edit / grounding repair (`edit` default = `nano-banana-pro`)
- **Today:** `edit_image` default balanced=`nano-banana-pro`, which takes `image_urls`
  (image + optional style exemplar, `image_edit.py:62-64`) — refs are **real** here. The
  grounding repair loop also calls `edit_image` with a minimal "fix just these" instruction
  (`generate.py:315-324`, `geometry_prompt.py:35-66`).
- **Ref support:** **real** on the default tier (2 refs). The `pro`/Kontext edit tier drops the
  2nd (style) ref (singular `image_url`) — `SESSION_AUDIT.md:99`.
- **Recommendation:** **keep nano-banana-pro** as the default edit model — it is the one path
  where the style exemplar + identity actually work. Don't route entity-edits through Kontext
  (loses the style ref).

## PAID BAKEOFF DESIGN (~$25 budget)

**Goal:** confirm/refute the five calls above with numbers, on the project's real failure modes
(style drift on fresh/scale_parent, faithful zoom, in-style outpaint, layout compliance).

### Candidates × scenarios × conditions

| Scenario | Candidates | Conditions |
|---|---|---|
| **S1 Fresh map** | nano-banana-pro, seedream-v4-t2i | MEDIUM-LOCK text on/off; ref attached on/off (prove the no-op) |
| **S2 Zoom-continue** | flux-pro/kontext, nano-banana-pro/edit | with/without named-features clause |
| **S3 Map-pan outpaint** | bria/expand | margin-prompt present vs empty (prove the photoreal drift) |
| **S4 OUTWARD container** | nano-banana-pro/edit (ref-real) vs nano-banana-pro t2i (ref no-op) | both with style-anchor text |
| **S5 Layout compliance** | nano-banana-pro | bins clause on/off (the 02-doc A/B; shared with §02) |

Fixed seed-prompt set: 5 worlds (engraving city, watercolour forest, blueprint station, flat
infographic, ink dungeon) so style + label legibility are judged across mediums.

### Generation count + cost

- S1: 2 models × 5 worlds × 4 conditions = 40
- S2: 2 × 5 × 2 = 20
- S3: 1 × 5 × 2 = 10
- S4: 2 × 5 × 1 = 10
- S5: 1 × 5 × 2 = 10
- **Total ≈ 90 generations.** At fal's ~$0.04–0.15/image (nano-banana-pro/seedream-edit class;
  Kontext/BRIA similar) → **~$4–14**. Budget 2 reruns + the VLM-judge calls (Gemini, cheap) →
  comfortably **< $25**.

### VLM-judge rubric (judge = **Gemini**, never qwen — it 429s and silently breaks judging;
memory `project_qwen_ratelimit`)

Score each output 0–10 on four axes, reusing the project's existing `score_style_pair` shape
where possible:
1. **Medium fidelity** — is it the same art medium as the reference world? (the core drift metric)
2. **Faithfulness** (S2/S3/S4 only) — does it continue the SAME place (walls/landmarks kept), not
   a reinvention?
3. **Layout compliance** (S5) — fraction of listed entities at their stated h_pos/v_pos bin
   (mirror T2I-CompBench: detector centroids vs. expected bins [T2I-CompBench NeurIPS'23]).
4. **Label legibility** — are in-image labels readable, not garbled? (separates nano-banana-pro
   from the non-pro pin and from Kontext).

### What the run must measure (per recommendation)

- **R1 (keep nano-banana-pro fresh):** S1 — does the ref-on vs ref-off pair score identically?
  (confirms no-op → justifies dropping the upload). Does pro beat seedream on label legibility?
- **R2 (keep Kontext zoom):** S2 — does Kontext beat nano-banana-pro/edit on *faithfulness*? If
  nano-banana-pro/edit ties **and** wins label legibility, recommend unifying zoom on it (regains
  the style ref).
- **R3 (BRIA needs margin-prompt):** S3 — margin-prompt-empty should score far lower on medium
  fidelity (confirms `image_edit.py:316-319`'s warning, makes the "callers MUST pass it" a test).
- **R4 (fix scale_parent ref no-op):** S4 — nano-banana-pro/**edit** (real ref) vs t2i (no-op)
  on medium fidelity + faithfulness. A real gap → route OUTWARD container through the edit
  endpoint (recommendation #4).
- **R5 (layout bins):** S5 — see `02-prompting.md`; the single most decision-relevant unknown.

## Sources

- fal nano-banana-pro/edit — https://fal.ai/models/fal-ai/nano-banana-pro/edit
- fal Nano Banana 2 / edit — https://fal.ai/models/fal-ai/nano-banana-2 , https://fal.ai/models/fal-ai/nano-banana-2/edit
- FLUX.1 Kontext — arXiv 2506.15742 ; https://www.together.ai/blog/flux-1-kontext ; fal flux-pro/kontext
- BRIA Expand — https://fal.ai/models/fal-ai/bria/expand/api ; https://docs.bria.ai/image-editing/v2-endpoints/image-expansion
- Seedream v4/4.5 — https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/edit ; https://seed.bytedance.com/en/seedream4_0
- IP-Adapter vs DreamBooth — https://huggingface.co/docs/diffusers/using-diffusers/ip_adapter ; https://www.mercity.ai/blog-post/understanding-and-training-ip-adapters-for-diffusion-models/
- T2I-CompBench — NeurIPS 2023, arXiv 2307.06350
