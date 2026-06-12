# UI audit — the whole journey, both modes, and the debt list

A single pass over everything a user touches, from first load to a deep
world session. Written June 2026 alongside the world-mode reliability run
(PRs #63–#70); line references are approximate by design — find by name.

## The journey, first load → deep session

1. **First load** (`app/play/page.tsx`): the query toolbar (`QueryToolbar`)
   with locale/theme/tier knobs, the **world pill** (off by default; `auto`
   / `semi` / `labels` sub-pills appear when on), and the style gallery
   (`StyleGallery`, sessionStorage-dismissable) for picking a visual anchor.
2. **First generation**: query → `/api/generate-page` (SSE: `status` →
   `progress` draft → `final`) → `persistNode` → async entity extraction
   (`/api/world/{id}/extract`) seeds the codex + geo map a beat later.
3. **Exploring (classic mode)**: hover shows the red crosshair
   (`HoverCrosshair`); a tap explains the thing under the cursor (topical
   depth). `E` blooms Around (breadth). Shift+drag annotates a stroke;
   ⌘/Ctrl-click floats a hint input; Edit mode drags a region for
   mask-scoped edits. The `FirstRunCoach` pill teaches tap/around — now
   only until the first tap-child exists.
4. **World mode** (the pill, or the on-figure chip): a tap ENTERS the place
   under the finger. Routing is geometric first (`geoTapRequest` over the
   seeded 100×60 frame), then label-match (lettering names a mapped place,
   #63), then the submap zoom-cut degrade (#63) — never the fresh
   reinvention path. Pulsing emerald rings mark enterable places and the
   crosshair flips to an "enter" ring over them (#64). Entered places
   persist and a re-tap REOPENS the saved node.
5. **Inside a place**: `SpatialPath` (geo breadcrumb), `WorldMiniMap`
   (top-right coordinate inset, local frame), `GeometryOverlay` boxes via
   the `⊞ geo` toggle, the Codex panel for entities. Zoom out / step back
   in the top bar; `Breadcrumb` collapses deep trails to root › … › last
   two.
6. **Atlas** (`/atlas/{session}` or the `↗ atlas` button): the zoomable
   session map — depth-coloured tiles, dotted enter-edges, entity pins,
   camera-gaze anchors, mini-map.
7. **Sharing**: permalink per node (`/n/{id}`), exports (PDF/ZIP/GIF) via
   the context menu, publish-to-gallery.

## The two modes (and when to use which)

|                      | Classic explore                  | World mode                                  |
| -------------------- | -------------------------------- | ------------------------------------------- |
| A tap means          | "explain THIS"                   | "take me INTO this place"                   |
| Best for             | concepts, diagrams, topics       | maps, places, anything with WHERE           |
| Output of a tap      | a labelled explainer page        | a scene or a closer sub-map (Kontext zoom)  |
| Geography            | none (each page standalone)      | one numeric world; landmarks stay put       |
| Re-tap a place       | a new explainer                  | reopens the saved node                      |
| Visible indicator    | —                                | 🌍 chip on the figure + rings on places     |
| Labels               | baked into the image             | optional DOM labels (`labels` pill, #70)    |

Rule of thumb: if the image is a MAP (or you care where things are), turn
world on. If you're reading about a topic, leave it off — the classic tap
is better at "what is this".

## Debt list (prioritized; ✅ = fixed in this run)

1. ✅ **Un-anchored world taps reinvented the scene** — the fresh path
   ignores image refs (#63: label-match + submap degrade).
2. ✅ **No enter affordance** — rings + enter cursor + coach hint (#64).
3. ✅ **Baked lettering garbles + hijacks clicks** — DOM-labels mode (#70).
4. ✅ **No persistent mode indicator** — the toolbar pill was the only
   signal; now the 🌍 chip sits on the figure and toggles off in place.
5. ✅ **FirstRunCoach overlapped the Pin-style chip** and clipped its text
   (`overflow-x-auto`); it also never went away. Now wraps, and renders
   only until the first tap-child exists.
6. ✅ **WorldMiniMap label soup** — every dot got SVG text; collisions were
   guaranteed. Now only the 6 largest footprints carry names.
7. ✅ **Breadcrumb overflow** on deep trails — collapses to root › … › last
   two with an expander.
8. **`⊞ geo` and entity-chip toggles are buried** — discoverable only by
   reading the toolbar; a keyboard shortcut (`G`) and a hint would help.
9. **Entity chips need `appearance_bboxes[nodeId]`** — pre-Phase-4 extracts
   show no on-image affordance even when the codex knows the entity; a
   placeholder ("not yet localized") would close the gap.
10. **Hover-prefetch is invisible** — silent VLM warming on hover has no
    debug surface; a dev HUD toggle would make cost behaviour visible.
11. **`view.layout_register_mismatch` silently suppresses layout steering**
    (backend) — logged but invisible to the user; the eval track
    (`tests/recon_bench`) is the right place to measure how much it costs.
12. **Edit-verdict chip can overlap narrow screens** — toast-corner
    placement would be safer.
13. **Mobile pass** — breadcrumbs, codex panel and the geo inset all want a
    ≤390px audit; only the coach and breadcrumb were touched here.

## Where the eval system hooks in

The reconstruction bench (`make eval-recon`) and the matrix sweep
(`make eval-matrix-dry` → `eval-matrix`) measure the generation half of
everything above: layout fidelity (raw vs aligned register), heights,
style, plausibility, per-model cost. UI changes that alter prompts (e.g.
DOM-labels mode) should run the recon bench before/after — `recon_fidelity`
in `tests/eval_baselines.json` is the gate.
