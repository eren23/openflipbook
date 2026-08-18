# Branch 2 — systematic consistency / geometry fixes

`feat/systematic-consistency`, off main, parameterized by `docs/research/` (PR #31).
Each fix is **flag-gated off by default** + anchor-verified; `make eval` green per commit.

## Landed

| P | fix | flag | anchor |
|---|---|---|---|
| P1 | wire `expected_layout` into the describe-a-place render (new `projectTopDown`) | `WORLD_GEOMETRY_GEN` (existing) | `projectTopDown` unit test; bakeoff-confirmed **+0.33** layout fidelity |
| P2 | route OUTWARD `scale_parent` through the edit endpoint (fixes the text-to-image ref no-op) | `SCALE_OUTWARD_EDIT_REF` (new) | ascend test asserts the edit-route gets the source + medium |
| P5 | baseline-drift guard — committed thresholds + pure `compare()` | — (free CI gate) | `test_eval_baselines` (well-formed + verdicts) |
| P6 | runtime INV-2 enforcement on the OUTWARD reparent (was test-only) | — (always; rejects bad input at the boundary) | existing `tierTransitionValid` unit tests |

**P3 — verifiable entity edit/delete.** The deterministic edit-apply is **already
anchored** (`applyEntityEdit` move/set_height/set_appearance/remove/add/no-op tests in
`world-map.test.ts`). The remaining piece is the **paid render-verification loop**
(project → apply → re-project → detect-diff: did the edit move the pixels and leave the
others put?) — deferred to a paid eval; the harness + `grounding.diff` are ready.

## Held for review — do NOT ship unverified

**P4 — promote B1 `inside` to true sub-frame nesting.** Today the solver emits `inside`
**flat-v1** (`parent_id: null`, the child shares the container's pos — `layout_solver.py`
`:172-177`, `:264`; deliberate + golden-tested). The DEEPER nesting model already exists
(`parent_id` + a learned `scale`; `world-map.ts deriveGeoFromExtraction`; `resolveAbsolutePos`
chases the parent chain). Promoting it means, behind a **default-off `nest_inside` param**
(so the flat golden test stays green):
- `_resolve_pos` records the container's instance ref on the `inside` child;
- `_emit` sets `parent_id = geo_plan_<container>`, a **local** child pos, and the container's
  learned `scale = footprint-extent ÷ interior localExtent`;
- a new nested golden test + a **parity check** that the nested child's `resolveAbsolutePos`
  matches the TS engine, and a **tap-routing** test that a tap on the rendered nested place
  routes back to it.

Held because it changes the deterministic solver's **frame/scale convention** — getting it
subtly wrong corrupts the world model (the exact failure this program targets), and it needs
a **paid render + tap verification** that can't run free. The design above is ready; it wants
eyes-on before it lands.

## Deferred paid runs (harness ready, sequence when budget allows)

- **S4 OUTWARD A/B** — does P2's edit-route beat the text-to-image no-op on medium fidelity?
  (`docs/research/01`, `07`; the now-existing edit-route is the code S4 needed.) *Still deferred.*

### Done (kept for provenance)

- **Multi-hop drift `chain_runner` (`half_life`)** — DONE. `chain_runner.py` built (#215) and run
  (#216/#217): style-anchored OUTWARD still loses delicate media by ~hop 2; shipped the
  flag-gated `SCALE_OUTWARD_MAX_HOPS` re-anchor cap (default off).
- **Labelled-map model A/B** — DONE (#214, `tests/matrix_bench/sweeps/map-model-ab.json`).
  On real corpus maps at full composite, `nano-banana-pro` earns its cost (0.762 vs ~0.66);
  `nano-banana-2` is dominated. n=2 — re-run at higher n before any production default change.
