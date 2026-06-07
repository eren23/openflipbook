import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ObserverPose } from "@openflipbook/config";

import { project, projectScene, type ProjectInput } from "./world-geometry";

// P1 cross-language parity-fuzz (TS side). Runs the TS engine over the SAME
// random corpus the Python engine produced and must reproduce every projection
// within 1e-6 (and agree on every cull) — the strongest TS/Py drift guard.
interface FuzzScene {
  observer: ObserverPose;
  aspect: number;
  entities: ProjectInput[];
  expected: Array<Record<string, unknown>>;
}
const fuzz = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "../../packages/config/src/projection-fuzz.json"),
    "utf8",
  ),
) as { scenes: FuzzScene[] };

const FLOATS = ["x_pct", "y_pct", "w_pct", "h_pct", "depth"] as const;
const BINS = ["id", "label", "h_pos", "v_pos", "size"] as const;

describe("world-geometry cross-language parity fuzz", () => {
  it("TS engine reproduces every Python projection within 1e-6", () => {
    let total = 0;
    for (const sc of fuzz.scenes) {
      const out = projectScene(sc.entities, sc.observer, sc.aspect);
      // Same entities visible, same order ⇒ identical cull + depth-sort decisions.
      expect(out.map((p) => p.id)).toEqual(sc.expected.map((e) => e.id));
      out.forEach((got, i) => {
        const exp = sc.expected[i]!;
        const g = got as unknown as Record<string, unknown>;
        for (const f of BINS) expect(g[f]).toBe(exp[f]);
        for (const f of FLOATS)
          expect(g[f] as number).toBeCloseTo(exp[f] as number, 6);
      });
      total += out.length;
    }
    // Exact: corpus is seed-pinned + deterministic, so a silently-trimmed regen
    // (fewer projections) trips the gate, not just an all-culled corpus.
    expect(total).toBe(259);
  });

  it("left/right mirror symmetry (structural truth)", () => {
    const obs: ObserverPose = {
      pos: { x: 0, y: 0 },
      eye_height: 1.7,
      gaze: 0,
      fov: Math.PI / 2,
    };
    const d = 50;
    const ent = (id: string, ang: number): ProjectInput => ({
      id,
      label: id,
      pos: { x: d * Math.cos(ang), y: d * Math.sin(ang) },
      height: 5,
      footprint: { w: 4, d: 4 },
    });
    for (const ang of [0.2, 0.6, 1.1, 1.3]) {
      if (ang >= Math.PI / 4) {
        // past the edge → both mirror entities culled (symmetry holds for null too)
        expect(project(ent("r", ang), obs, 1.0)).toBeNull();
        expect(project(ent("l", -ang), obs, 1.0)).toBeNull();
        continue;
      }
      const left = project(ent("l", -ang), obs, 1.0)!;
      const right = project(ent("r", ang), obs, 1.0)!;
      expect(left.x_pct).toBeCloseTo(1.0 - right.x_pct, 9);
      expect(left.y_pct).toBeCloseTo(right.y_pct, 9);
      expect(left.w_pct).toBeCloseTo(right.w_pct, 9);
    }
  });
});
