import type { WorldEntityGeo } from "@openflipbook/config";
import { describe, expect, it } from "vitest";

import { blockDistance, renderLayoutControl, type LayoutVisible } from "./layout-control";
import { paintedShots, resample, routeFromStroke, routeShots, snapGround, snapMove, snapObjects, strokeToWorld, type RouteShot } from "./route-line";

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

  // Live town, 2026-09-20: the drawn stroke came back scattered, cameras piled
  // on whatever spots were open. Extracted footprints cover 79% of that town
  // and interpenetrate by 5.3 units, so a camera is pushed a long way to find
  // clear ground -- a median 4 units off the line at the pedestrian gap. What
  // matters is not how many cameras move but how far they end up from what the
  // user drew.
  it("keeps the walk near the line the user drew", () => {
    const town = [
      geo("The Copper Kettle", 37, 29.1, 16.2, 13.3, 7.2),
      geo("Tideglass Apothecary", 45.4, 18.5, 10.7, 8.8, 5),
      geo("Candleworks", 34.7, 19, 10.8, 7.8, 5),
      geo("Mapmaker House", 58.9, 19, 13.8, 11.3, 5.7),
      geo("Bellfounder Hall", 68.6, 32.6, 19.8, 16.3, 7.5),
      geo("Blue Shutter Bakery", 71.9, 21.3, 13.4, 11, 5.6),
    ];
    const stroke = line([40, 12], [58, 42], 40);
    const strayOf = (opts: object) =>
      routeFromStroke(stroke, town, { maxStepUnits: 4, ...opts }).checkpoints
        .map((c) => Math.min(...stroke.map((q) => Math.hypot(q.x - c.observer.pos.x, q.y - c.observer.pos.y))))
        .sort((a, b) => a - b);
    const carved = strayOf({});
    const raw = strayOf({ laneGap: 0 });
    expect(raw[raw.length - 1]).toBeGreaterThan(10);
    expect(carved[carved.length - 1]).toBeLessThan(6);
    expect(carved[Math.floor(carved.length / 2)]!).toBeLessThan(2);
  });

  // Live world, 2026-09-20: the district map's root frame holds one entity,
  // "The Riverward Quarter" -- 231 x 137 on a 100 x 86 world, the frame the
  // town's places are nested in. Walked as a wall it swallowed the map: all
  // 53 cameras stepped aside and the route looped outside the town.
  it("walks inside the quarter its places are nested in", () => {
    const quarter = geo("The Riverward Quarter", 50.6, 28.7, 231.3, 136.6, 4, { id: "geo_quarter" });
    const inn = geo("The Copper Kettle", 37, 29.1, 10, 12, 7.2, { parent_id: "geo_quarter" });
    const stroke = line([25, 20], [75, 45], 40);
    const r = routeFromStroke(stroke, [quarter, inn], { maxStepUnits: 4 });
    const stray = r.checkpoints.map((c) =>
      Math.min(...stroke.map((q) => Math.hypot(q.x - c.observer.pos.x, q.y - c.observer.pos.y))));
    expect(Math.max(...stray)).toBeLessThan(3);
    expect(r.checkpoints.some((c) => c.blocked)).toBe(false);
  });

  // A route can walk somewhere worth nothing -- the first walk's receipt named
  // it: "nothing stops it putting a camera against a wall, or facing open
  // ground where this town has no boxes". A shot knows what it is OF before
  // anything is painted, so the worthless ones can be dropped for free.
  it("says what each shot sees, and drops the ones that see nothing", () => {
    const town = [
      geo("The Copper Kettle", 40, 30, 10, 12, 8),
      geo("Bellfounder Hall", 40, 46, 10, 12, 8),
    ];
    // walks up the gap between them, then out into empty ground
    const shots = routeShots(
      routeFromStroke(line([40, 8], [40, 120], 40), town, { maxStepUnits: 12 }),
      town,
      { maxStepUnits: 12 },
    );
    expect(shots.length).toBeGreaterThan(2);
    const seeing = shots.filter((s) => s.worth);
    expect(seeing.length).toBeGreaterThan(0);
    expect(seeing.length).toBeLessThan(shots.length);
    // the shots that see something name it
    const labels = new Set(seeing.flatMap((s) => s.sees.map((v) => v.label)));
    expect(labels.has("The Copper Kettle") || labels.has("Bellfounder Hall")).toBe(true);
    // shares are a fraction of the frame, biggest first
    for (const s of seeing) {
      expect(s.built).toBeGreaterThan(0);
      expect(s.built).toBeLessThanOrEqual(1);
      for (let k = 1; k < s.sees.length; k++) expect(s.sees[k - 1]!.share).toBeGreaterThanOrEqual(s.sees[k]!.share);
    }
    // the far end of the walk is past the town, looking at nothing
    expect(shots[shots.length - 1]!.worth).toBe(false);
  });
});

describe("paintedShots", () => {
  const shot = (index: number, x: number, y: number, worth = true) =>
    ({ index, observer: { pos: { x, y }, eye_height: 1.7, gaze: 0, fov: 1, pitch: 0 }, distance: x, reason: "turn", sees: [], built: 0.3, worth }) as RouteShot;
  it("keeps one shot per standing spot: the walk starts facing where it goes", () => {
    // Live 2026-09-24: three shots stood at the start, so two of five paid clips
    // were the camera turning on the spot.
    const out = paintedShots([shot(0, 0, 0), shot(1, 0, 0), shot(2, 0, 0), shot(3, 19, 0), shot(4, 38, 0, false), shot(5, 40, 0)]);
    expect(out.map((s) => s.index)).toEqual([2, 3, 5]);
  });
});

describe("the snap-point spec", () => {
  const pose = (x: number, y: number, gaze: number) => ({ pos: { x, y }, eye_height: 1.7, gaze, fov: Math.PI / 2, pitch: 0 });

  it("a turn to the right is positive: map y grows down", () => {
    // Walking east (+x), then facing south, which is DOWN the map: seen from
    // above with north up, that is clockwise, a turn to the right.
    const move = snapMove(pose(10, 30, 0), pose(22, 35, Math.PI / 2));
    expect(move.turn_deg).toBeCloseTo(90, 9);
    expect(move.forward).toBeCloseTo(13, 9);
    expect(snapMove(pose(0, 0, 0), pose(0, 0, -Math.PI / 2)).turn_deg).toBeCloseTo(-90, 9);
  });

  it("takes the short way round, in (-180, 180]", () => {
    const deg = Math.PI / 180;
    expect(snapMove(pose(0, 0, 170 * deg), pose(0, 0, -170 * deg)).turn_deg).toBeCloseTo(20, 9);
    expect(snapMove(pose(0, 0, 0), pose(0, 0, Math.PI)).turn_deg).toBeCloseTo(180, 9);
    expect(snapMove(pose(0, 0, 0), pose(0, 0, -Math.PI)).turn_deg).toBeCloseTo(180, 9);
  });

  it("names what the camera sees, left to right, with what the world says it looks like", () => {
    // Facing east: north (smaller y) is on the camera's left.
    const town = [
      geo("Bellfounder Hall", 60, 40, 10, 10, 7.5, { visual: "a squat bell foundry" }),
      geo("The Copper Kettle", 60, 20, 10, 10, 7.2, { visual: "x".repeat(400) }),
      geo("River Quay", 60, 30, 100, 2, 1), // ground: never a block
    ];
    const at = pose(40, 30, 0);
    const control = renderLayoutControl(town, at, 160, 96);
    const objects = snapObjects(control.visible, town, at, 160 * 96);
    expect(objects.map((o) => o.label)).toEqual(["The Copper Kettle", "Bellfounder Hall"]);
    const [kettle, hall] = objects;
    expect(kettle!.h_pos).toMatch(/left/);
    expect(hall!.h_pos).toMatch(/right/);
    expect(hall!.visual).toBe("a squat bell foundry");
    expect(kettle!.visual!.length).toBe(240);
    expect(hall!.height).toBe(7.5);
    // to the nearest wall: the hall's west face is at x 55, its north face at y 35
    expect(hall!.distance).toBeCloseTo(Math.hypot(15, 5), 6);
    expect(hall!.share).toBeGreaterThan(0);
    expect(hall!.share).toBeLessThan(1);
    // the colour ties each name to its block in the control image
    expect(kettle!.color).toBe(control.visible.find((v) => v.label === "The Copper Kettle")!.color);
    expect(new Set(objects.map((o) => o.color)).size).toBe(2);
  });

  it("drops slivers", () => {
    const seen = (id: string, x: number, pixels: number) =>
      ({ id, label: id, x_pct: x, y_pct: 0.5, w_pct: 0.1, h_pct: 0.1, depth: 5, h_pos: "center", v_pos: "mid", size: "small", color: null, pixels }) as LayoutVisible;
    const objects = snapObjects([seen("wide", 0.8, 500), seen("sliver", 0.2, 4)], [], pose(0, 0, 0), 1000);
    expect(objects.map((o) => o.label)).toEqual(["wide"]);
    expect(objects[0]!.visual).toBeUndefined();
    expect(objects[0]!.color).toBeUndefined(); // a grey block past the palette
  });

  it("puts the river on the side it is on, nearest first", () => {
    const at = pose(40, 30, 0); // facing east
    const ground = snapGround([
      geo("River Lantern", 50, 45, 100, 6, 0.2, { visual: "slow green water" }), // south: right
      geo("Fishmarket Quay", 50, 20, 100, 4, 0.5), // north: left
      geo("Chapel Square", 22, 30, 8, 8, 0.1), // behind
      geo("Rope Road", 60, 30, 4, 30, 0.1), // ahead
      geo("Mill Lane", 64, 30, 4, 30, 0.1), // ahead too, but fifth
      geo("The Copper Kettle", 45, 30, 4, 4, 7), // a building, not ground
    ], at);
    expect(ground).toEqual([
      { label: "Fishmarket Quay", side: "left" },
      { label: "River Lantern", side: "right", visual: "slow green water" },
      { label: "Chapel Square", side: "behind" },
      { label: "Rope Road", side: "ahead" },
    ]);
  });

  it("leaves out districts and ground out of view, and says what is underfoot", () => {
    const at = pose(40, 30, 0);
    expect(snapGround([
      geo("Harbour District", 50, 45, 20, 6, 0.2),
      geo("Far Canal", 200, 30, 4, 30, 0.1),
      geo("Stone Quay", 40, 30, 10, 8, 0.2), // the camera stands on it
    ], at)).toEqual([{ label: "Stone Quay", side: "here" }]);
  });

  it("a quay alongside is on its side even when its nearest edge is ahead", () => {
    // Walking east just south of a quay that starts 5 units on: the nearest
    // edge is ahead-left, the line of sight never enters it.
    const quay = geo("River Quay", 65, 5, 60, 10, 0.2);
    expect(snapGround([quay], pose(30, 13, -0.13))).toEqual([{ label: "River Quay", side: "left" }]);
    // facing into it, it is ahead
    expect(snapGround([quay], pose(40, 13, -Math.PI / 2))).toEqual([{ label: "River Quay", side: "ahead" }]);
  });

  it("a river alongside is beside you, even when its middle is far ahead", () => {
    const river = geo("The River", 120, 36, 200, 4, 0.2);
    expect(snapGround([river], pose(40, 30, 0))).toEqual([{ label: "The River", side: "right" }]);
  });
});
