import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ObserverPose } from "@openflipbook/config";

import {
  cropEntities,
  neighborsOf,
  project,
  projectScene,
  type ProjectInput,
} from "./world-geometry";

// P1 geometry gate (TS side, FREE). Reproduces the SAME shared golden the Python
// engine produced (apps/modal-backend/tests/world_bench/test_geometry.py); any
// TS/Py divergence fails here. vitest runs with cwd = apps/web.
interface GoldenScene {
  name: string;
  observer: ObserverPose;
  entities: ProjectInput[];
  expected: Array<Record<string, unknown>>;
  culled: string[];
}
const golden = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "../../packages/config/src/projection-golden.json"),
    "utf8",
  ),
) as { aspect: number; scenes: GoldenScene[] };

const ASPECT = golden.aspect;
const FLOATS = ["x_pct", "y_pct", "w_pct", "h_pct", "depth"] as const;
const BINS = ["id", "label", "h_pos", "v_pos", "size"] as const;

const ent = (id: string, x: number, y: number, height = 5, fw = 4): ProjectInput => ({
  id,
  label: id,
  pos: { x, y },
  height,
  footprint: { w: fw, d: fw },
});
const OBS: ObserverPose = { pos: { x: 0, y: 0 }, eye_height: 1.7, gaze: 0, fov: Math.PI / 2 };

describe("world-geometry projection (P1 golden parity)", () => {
  it.each(golden.scenes.map((s) => [s.name, s] as const))(
    "%s reproduces the golden",
    (_name, scene) => {
      const out = projectScene(scene.entities, scene.observer, ASPECT);
      expect(out.map((p) => p.id)).toEqual(scene.expected.map((e) => e.id));
      const outIds = new Set(out.map((p) => p.id));
      const culled = scene.entities
        .filter((e) => !outIds.has(e.id))
        .map((e) => e.id)
        .sort();
      expect(culled).toEqual([...scene.culled].sort());
      out.forEach((got, i) => {
        const exp = scene.expected[i]!;
        const g = got as unknown as Record<string, unknown>;
        for (const f of BINS) expect(g[f]).toBe(exp[f]);
        for (const f of FLOATS) expect(g[f] as number).toBeCloseTo(exp[f] as number, 6);
      });
    },
  );
});

describe("world-geometry properties", () => {
  it("dead ahead → center", () => {
    const p = project(ent("a", 50, 0), OBS, ASPECT);
    expect(p).not.toBeNull();
    expect(p!.x_pct).toBeCloseTo(0.5, 9);
    expect(p!.h_pos).toBe("center");
  });
  it("behind → culled", () => expect(project(ent("a", -10, 0), OBS, ASPECT)).toBeNull());
  it("outside fov → culled", () => expect(project(ent("a", 0, -50), OBS, ASPECT)).toBeNull());
  it("farther → smaller", () => {
    const n = project(ent("a", 10, 0), OBS, ASPECT)!;
    const f = project(ent("a", 100, 0), OBS, ASPECT)!;
    expect(f.w_pct).toBeLessThan(n.w_pct);
    expect(f.depth).toBeGreaterThan(n.depth);
  });
  const elev = (
    id: string,
    x: number,
    y: number,
    height: number,
    elevation: number,
  ): ProjectInput => ({ id, label: id, pos: { x, y }, height, elevation, footprint: { w: 4, d: 4 } });
  it("elevation raises on screen", () => {
    const ground = project(ent("a", 40, 0, 2), OBS, ASPECT)!;
    const raised = project(elev("a", 40, 0, 2, 20), OBS, ASPECT)!;
    expect(raised.y_pct).toBeLessThan(ground.y_pct);
  });
  it("pitch up lowers the scene", () => {
    const level = project(ent("a", 40, 0, 2), OBS, ASPECT)!;
    const up = project(ent("a", 40, 0, 2), { ...OBS, pitch: 0.3 }, ASPECT)!;
    expect(up.y_pct).toBeGreaterThan(level.y_pct);
  });
  it("pitch/elevation default is byte-identical", () => {
    const a = project(ent("a", 40, 0, 8), OBS, ASPECT)!;
    const b = project(elev("a", 40, 0, 8, 0), { ...OBS, pitch: 0 }, ASPECT)!;
    expect(a.y_pct).toBeCloseTo(b.y_pct, 12);
    expect(a.h_pct).toBeCloseTo(b.h_pct, 12);
  });
  it("vertical frustum cull (look down at a tall close entity)", () =>
    expect(project(ent("a", 3, 0, 30), { ...OBS, pitch: -0.6 }, ASPECT)).toBeNull());
  it("crop window", () =>
    expect(
      cropEntities([ent("a", 5, 5), ent("b", 50, 50), ent("c", 9, 1)], {
        x: 0,
        y: 0,
        w: 10,
        h: 10,
      }).map((e) => e.id),
    ).toEqual(["a", "c"]));
  it("neighbors nearest first", () => {
    const nb = neighborsOf([ent("a", 0, 0), ent("b", 100, 0), ent("c", 5, 0)], "a", 5);
    expect(nb.map((n) => n.id)).toEqual(["c", "b"]);
    expect(nb[0]!.dist).toBeCloseTo(5);
  });
});
