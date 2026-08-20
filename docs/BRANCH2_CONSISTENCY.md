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

## Held for review

*(none — P4 shipped; see Done below.)*

## Deferred paid runs (harness ready, sequence when budget allows)

*(none currently — S4 ran; see Done below.)*

### Done (kept for provenance)

- **P4 sub-frame nesting** — SHIPPED (2026-08-20, `WORLD_NEST_INSIDE`, default off = flat v1
  byte-identical). The held design's corruption risk dissolved by construction: nesting is a
  **pure re-expression** — `resolveAbsolutePos`/`toAbsoluteEntities` return exactly the flat
  solve's absolute pos + footprint (invariant-tested both sides, plus a nested tap-routing
  test), so renders/taps/bounds are unchanged and the paid verification collapsed into free
  gates. One deviation from the sketch, called out in the PR: the scale denominator is the
  canonical frame extent, not the (degenerate-at-solve-time) interior localExtent.

- **S4 OUTWARD A/B** — DONE (n=2, `outward_runner.py`, ~$0.70). Both zoom-out paths hold the
  source MEDIUM well at a single hop: outpaint mean 9.75, fresh `scale_parent` rerender mean
  9.25, drift only 0.5. The FRESH default is **trustworthy** (clears the 6.5 bar at both cases:
  engraving 9.5, watercolour 9.0) — the edit-route does NOT lose the medium vs the no-op here.
  Caveat n=2: the runner asks for N≥10 before flipping `SCALE_OUTWARD_RERENDER` on by default.
  (Single-hop only — the COMPOUNDING loss across many hops is the separate chain_runner finding.)

- **Multi-hop drift `chain_runner` (`half_life`)** — DONE. `chain_runner.py` built (#215) and run
  (#216/#217): style-anchored OUTWARD still loses delicate media by ~hop 2; shipped the
  flag-gated `SCALE_OUTWARD_MAX_HOPS` re-anchor cap (default off).
- **Labelled-map model A/B** — DONE (#214, `tests/matrix_bench/sweeps/map-model-ab.json`).
  On real corpus maps at full composite, `nano-banana-pro` earns its cost (0.762 vs ~0.66);
  `nano-banana-2` is dominated. n=2 — re-run at higher n before any production default change.
