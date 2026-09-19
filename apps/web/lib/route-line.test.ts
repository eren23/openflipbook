import type { WorldEntityGeo } from "@openflipbook/config";
import { describe, expect, it } from "vitest";

import { blockDistance } from "./layout-control";
import { resample, routeFromStroke, strokeToWorld } from "./route-line";

const geo = (label: string, x: number, y: number, w: number, d: number, height: number, extra: Partial<WorldEntityGeo> = {}) =>
  ({ id: `geo_${label}`, entity_id: null, kind: "place", label, pos: { x, y }, footprint: { w, d }, height, visual: "", state: {}, confidence: 1, source: "extracted", updated_at: "", ...extra }) as unknown as WorldEntityGeo;

const line = (from: [number, number], to: [number, number], n = 20) =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: from[0] + ((to[0] - from[0]) * i) / n, y: from[1] + ((to[1] - from[1]) * i) / n }));

describe("strokeToWorld", () => {
  it("maps image-normalized points through the page's frame", () => {
    const frame = { x: -65, y: -39.6, w: 231.3, h: 136.6 }; // the live zoomed-out map
    const [p] = strokeToWorld([{ x: 0.441, y: 0.503 }], frame);
    expect(p!.x).toBeCloseTo(37, 0);
    expect(p!.y).toBeCloseTo(29.1, 0);
  });
});

describe("resample", () => {
  it("evens out a jittery stroke and keeps both ends", () => {
    const pts = resample([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 2);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]!.x).toBeCloseTo(10, 6);
    expect(pts[pts.length - 1]!.y).toBeCloseTo(10, 6);
    for (let i = 1; i < pts.length - 1; i++) {
      expect(Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)).toBeCloseTo(2, 6);
    }
  });
});

describe("routeFromStroke", () => {
  it("a straight walk gets a start and an end, cameras facing along it", () => {
    const route = routeFromStroke(line([10, 30], [40, 30]), [], { maxStepUnits: 100 });
    expect(route.checkpoints.map((c) => c.reason)).toEqual(["start", "end"]);
    expect(route.length).toBeCloseTo(30, 6);
    for (const c of route.checkpoints) expect(c.observer.gaze).toBeCloseTo(0, 6);
    expect(route.checkpoints[0]!.observer.eye_height).toBe(1.7);
  });

  it("adds a checkpoint where the route turns 30 degrees", () => {
    const corner = [...line([0, 0], [30, 0], 30), ...line([30, 0], [30, 30], 30)];
    const reasons = routeFromStroke(corner, [], { maxStepUnits: 1000 }).checkpoints.map((c) => c.reason);
    expect(reasons[0]).toBe("start");
    expect(reasons).toContain("turn");
    expect(reasons[reasons.length - 1]).toBe("end");
    // No step between checkpoints may turn more than the 30-degree limit.
    const route = routeFromStroke(corner, [], { maxStepUnits: 1000 });
    const gazes = route.checkpoints.map((c) => c.observer.gaze);
    for (let i = 1; i < gazes.length; i++) {
      const turn = Math.abs(Math.atan2(Math.sin(gazes[i]! - gazes[i - 1]!), Math.cos(gazes[i]! - gazes[i - 1]!)));
      expect(turn).toBeLessThanOrEqual(Math.PI / 6 + 1e-9);
    }
    expect(gazes[gazes.length - 1]).toBeCloseTo(Math.PI / 2, 6);
  });

  it("adds checkpoints on a long straight run", () => {
    const reasons = routeFromStroke(line([0, 0], [60, 0], 60), [], { maxStepUnits: 20 }).checkpoints.map((c) => c.reason);
    expect(reasons.filter((r) => r === "distance")).toHaveLength(2);
  });

  it("walks around a building in the way, keeping its distance", () => {
    const inn = geo("The Copper Kettle", 37, 29.1, 16.2, 13.3, 7.2); // standoff 3.24
    const route = routeFromStroke(line([20, 29.1], [55, 29.1]), [inn], { maxStepUnits: 8 });
    for (const c of route.checkpoints) expect(blockDistance(inn as never, c.observer.pos)).toBeGreaterThan(2.8);
    expect(route.checkpoints.some((c) => c.moved)).toBe(true);
  });

  it("goes around without doubling the walk (no zig-zag)", () => {
    // Live 2026-09-17: a per-sample "first clear side" search turned a 75-unit
    // walk through the town into a 191-unit zig-zag.
    const town = [
      geo("The Copper Kettle", 37, 29.1, 16.2, 13.3, 7.2),
      geo("Central Public Well", 52.3, 28.4, 8.2, 6.7, 4.7),
      geo("Bellfounder Hall", 68.6, 32.6, 19.8, 16.3, 7.5),
      geo("Ropewalk Store", 43.4, 41.8, 15.5, 12.7, 6.1),
    ];
    const drawn = line([20, 36], [75, 30], 40);
    const route = routeFromStroke(drawn, town, { maxStepUnits: 18 });
    let straight = 0;
    for (let i = 1; i < drawn.length; i++) straight += Math.hypot(drawn[i]!.x - drawn[i - 1]!.x, drawn[i]!.y - drawn[i - 1]!.y);
    expect(route.length).toBeLessThan(straight * 1.35);
    // ...and the walk stays on one side instead of crossing back and forth.
    const sideChanges = route.path.slice(1).filter((p, i) => Math.sign(p.y - 33) !== Math.sign(route.path[i]!.y - 33)).length;
    expect(sideChanges).toBeLessThanOrEqual(2);
  });

  it("keeps its distance from a tall building, not just outside it", () => {
    const hall = geo("Bellfounder Hall", 68.6, 32.6, 19.8, 16.3, 7.5); // standoff 4.5
    const route = routeFromStroke(line([50, 32.6], [90, 32.6]), [hall], { maxStepUnits: 8 });
    for (const c of route.checkpoints) {
      expect(blockDistance(hall as never, c.observer.pos)).toBeGreaterThan(7.5 * 0.45 - 0.5);
    }
  });

  it("leaves an already clear route exactly where it was drawn", () => {
    const inn = geo("The Copper Kettle", 37, 29.1, 16.2, 13.3, 7.2);
    const drawn = line([10, 55], [60, 55]);
    const route = routeFromStroke(drawn, [inn], { maxStepUnits: 12 });
    expect(route.checkpoints.every((c) => !c.moved)).toBe(true);
    for (const c of route.checkpoints) expect(c.observer.pos.y).toBeCloseTo(55, 9);
  });

  it("holds the middle of an alley too narrow for a full standoff", () => {
    // Two tall rows 6 units apart (y 27..33); the 4.5 standoff cannot be met,
    // so the camera keeps the centre line instead of fleeing sideways.
    const north = geo("north row", 30, 22, 40, 10, 7.5); // standoff 3.375
    const south = geo("south row", 30, 38, 40, 10, 7.5);
    const route = routeFromStroke(line([15, 30], [45, 30]), [north, south], { maxStepUnits: 6 });
    for (const c of route.checkpoints) {
      expect(c.observer.pos.y).toBeCloseTo(30, 6);
      expect(blockDistance(north as never, c.observer.pos)).toBeCloseTo(3, 6);
      expect(blockDistance(south as never, c.observer.pos)).toBeCloseTo(3, 6);
    }
  });

  it("says when the line is drawn straight through a building", () => {
    // Nothing to carve against here: one hall, no neighbour, and the stroke
    // goes through the middle of it. Every camera would stand inside a wall,
    // and the route says so rather than pretending otherwise.
    const hall = geo("Great Hall", 40, 30, 44, 40, 9);
    const route = routeFromStroke(line([20, 30], [60, 30]), [hall], { maxStepUnits: 10 });
    expect(route.checkpoints.some((c) => c.blocked)).toBe(true);
  });

  it("walks between two rows that were extracted overlapping", () => {
    // The live map has pairs like this: boxes drawn into each other, with no
    // gap at all. Narrowing them about their centres opens the lane, and the
    // walk goes down it instead of reporting the whole town impassable.
    const north = geo("north", 40, 20, 30, 20, 7);
    const south = geo("south", 40, 40.4, 30, 20, 7);
    const route = routeFromStroke(line([20, 30], [60, 30]), [north, south], { maxStepUnits: 10 });
    expect(route.checkpoints.every((c) => !c.blocked)).toBe(true);
    // ...and down the middle of it, not hugging either row.
    for (const c of route.checkpoints) expect(Math.abs(c.observer.pos.y - 30.2)).toBeLessThan(2.5);

    // With carving switched off, the same line has nowhere to stand.
    const raw = routeFromStroke(line([20, 30], [60, 30]), [north, south], { maxStepUnits: 10, laneGap: 0 });
    expect(raw.checkpoints.some((c) => c.blocked)).toBe(true);
  });

  it("an open lane keeps the drawn walk and few keyframes", () => {
    const town = [
      geo("The Copper Kettle", 37, 29.1, 16.2, 13.3, 7.2),
      geo("Bellfounder Hall", 68.6, 32.6, 19.8, 16.3, 7.5),
      geo("Ropewalk Store", 43.4, 41.8, 15.5, 12.7, 6.1),
    ];
    const drawn = line([15, 55], [85, 52], 40);
    const route = routeFromStroke(drawn, town, { maxStepUnits: 18 });
    let straight = 0;
    for (let i = 1; i < drawn.length; i++) straight += Math.hypot(drawn[i]!.x - drawn[i - 1]!.x, drawn[i]!.y - drawn[i - 1]!.y);
    expect(route.length).toBeCloseTo(straight, 1);
    expect(route.checkpoints.every((c) => !c.blocked)).toBe(true);
    expect(route.checkpoints.length).toBeLessThanOrEqual(8);
  });

  it("points every camera at the tapped place when one is given", () => {
    const lookAt = { x: 37, y: 29.1 };
    for (const c of routeFromStroke(line([10, 50], [60, 50]), [], { lookAt, maxStepUnits: 15 }).checkpoints) {
      expect(c.observer.gaze).toBeCloseTo(Math.atan2(lookAt.y - c.observer.pos.y, lookAt.x - c.observer.pos.x), 9);
    }
  });

  it("ignores a copy that hangs under another frame", () => {
    const copy = geo("The Copper Kettle", 37, 29.1, 16.2, 13.3, 7.2, { parent_id: "scene" });
    const route = routeFromStroke(line([30, 29.1], [45, 29.1]), [copy], { maxStepUnits: 100 });
    expect(route.checkpoints.every((c) => !c.moved)).toBe(true);
  });

  it("keeps the whole route finite when one place carries a broken number", () => {
    // A VLM has put NaN in a coordinate before. Every distance taken against
    // that block is NaN, and a NaN cost loses every comparison in the walk, so
    // without a guard the ENTIRE route comes back NaN, not just this corner.
    const broken = geo("Nowhere", NaN, 29.1, 16.2, 13.3, 7.2);
    const route = routeFromStroke(line([10, 29.1], [60, 29.1]), [broken], { maxStepUnits: 15 });
    expect(route.path.length).toBeGreaterThan(1);
    expect(route.path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(route.checkpoints.every((c) => Number.isFinite(c.observer.gaze))).toBe(true);
    expect(Number.isFinite(route.length)).toBe(true);
  });

  it("caps the work a long stroke can ask for", () => {
    // The sideways walk costs samples x offsets squared, and it reruns on every
    // pointer move: a stroke across a zoomed-out map must not grow unbounded.
    const long = routeFromStroke(line([0, 0], [4000, 0]), [], { maxStepUnits: 18 });
    expect(long.path.length).toBeLessThanOrEqual(241);
    expect(long.length).toBeCloseTo(4000, 0);
  });

  it("a single tap is not a route", () => {
    expect(routeFromStroke([{ x: 5, y: 5 }]).checkpoints).toEqual([]);
  });
});
