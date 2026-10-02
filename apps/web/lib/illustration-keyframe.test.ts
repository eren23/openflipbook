import { Box3, PerspectiveCamera, Plane, Ray, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { compositeChain, gateTruth, paintedDelta, pickCandidate, warpKeyframe, type KeyframeView } from "./illustration-keyframe";

const W = 64, H = 48, NEAR = 1, FAR = 30;
// A wall 10 m away that stops 3 m up (sky above), and a 2 m box in front of it.
const BOX = new Box3(new Vector3(-1, -1, -6), new Vector3(1, 1, -4));
const WALL = new Plane(new Vector3(0, 0, 1), 10);

function camera(x: number, yawDeg = 0, y = 0, pitchDeg = 0, z = 0) {
  const cam = new PerspectiveCamera(60, W / H, 0.1, 100);
  cam.position.set(x, y, z);
  cam.rotation.set(pitchDeg * Math.PI / 180, yawDeg * Math.PI / 180, 0, "YXZ");
  cam.updateMatrixWorld();
  return cam;
}

/** Ray-cast the test scene: render RGBA, depth RGBA and the world hit per pixel. */
function capture(cam: PerspectiveCamera) {
  const render = new Uint8Array(W * H * 4), depth = new Uint8Array(W * H * 4);
  const hits: (Vector3 | null)[] = [];
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const p = v * W + u, dir = new Vector3((u + 0.5) / W * 2 - 1, 1 - (v + 0.5) / H * 2, 0.5).unproject(cam).sub(cam.position).normalize();
    const ray = new Ray(cam.position.clone(), dir);
    let hit = ray.intersectBox(BOX, new Vector3()), rgb: number[];
    if (hit) rgb = Math.abs(hit.x - 1) < 1e-6 ? [0, 200, 0] : Math.abs(hit.z + 4) < 1e-6 ? [220, 0, 0] : [90, 90, 90];
    else {
      hit = ray.intersectPlane(WALL, new Vector3());
      if (hit && (hit.y > 3 || -hit.clone().applyMatrix4(cam.matrixWorldInverse).z > FAR)) hit = null; // beyond the depth range reads as sky
      rgb = hit ? (Math.floor(hit.x / 4) & 1 ? [0, 0, 230] : [240, 220, 0]) : [100 + Math.round(dir.x * 100), 150, 255];
    }
    hits.push(hit);
    render.set([...rgb, 255], p * 4);
    const z = hit ? -hit.clone().applyMatrix4(cam.matrixWorldInverse).z : 0;
    const b = hit ? Math.round(255 * (1 - (z - NEAR) / (FAR - NEAR))) : 0;
    depth.set([b, b, b, 255], p * 4);
  }
  const view: KeyframeView = { width: W, height: H, depth: { near: NEAR, far: FAR },
    camera: { projection: "perspective", world_matrix: cam.matrixWorld.toArray(), projection_matrix: cam.projectionMatrix.toArray(), near: 0.1, far: 100 } };
  return { view, render, depth, hits };
}

const rgbEqual = (a: Uint8Array, b: Uint8Array, p: number) => a[p * 4] === b[p * 4] && a[p * 4 + 1] === b[p * 4 + 1] && a[p * 4 + 2] === b[p * 4 + 2];

/** A's sky row means, from sky more than 1 px (1% of the frame) from A's geometry; rows without take the nearest row with some. */
function skyRows(image: Uint8Array, hits: (Vector3 | null)[]) {
  const means = Array.from({ length: H }, (_, y) => {
    const px: number[][] = [];
    for (let x = 0; x < W; x++)
      if (![-1, 0, 1].some(j => [-1, 0, 1].some(i => y + j >= 0 && y + j < H && x + i >= 0 && x + i < W && hits[(y + j) * W + x + i])))
        px.push([...image.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]);
    return px.length ? [0, 1, 2].map(c => Math.round(px.reduce((sum, rgb) => sum + rgb[c]!, 0) / px.length)) : null;
  });
  return means.map((_, y) => {
    for (let d = 0; d < H; d++) { const mean = means[y - d] ?? means[y + d]; if (mean) return [...mean, 255]; }
    return null;
  });
}

describe("warpKeyframe", () => {
  it("leaves a view warped into itself unchanged, with no holes, and paints its sky with A's row means", () => {
    const a = capture(camera(0));
    const out = warpKeyframe({ view: a.view, image: a.render, depth: a.depth }, { view: a.view, render: a.render, depth: a.depth });
    const rows = skyRows(a.render, a.hits);
    let geometry = 0, sky = 0;
    for (let p = 0; p < W * H; p++) {
      if (a.hits[p]) { geometry++; expect(rgbEqual(out.rgba, a.render, p)).toBe(true); expect(out.hole[p]).toBe(0); continue; }
      sky++;
      expect([out.sky[p], out.hole[p]]).toEqual([1, 0]);
      expect([...out.rgba.subarray(p * 4, p * 4 + 4)]).toEqual(rows[Math.floor(p / W)]);
    }
    expect(geometry).toBeGreaterThan(0);
    expect(sky).toBeGreaterThan(0);
    expect(out.holeShare).toBe(0);
    expect(out.angleDeg).toBeCloseTo(0, 6);
  });

  it("keeps (almost) every pixel of frontal surfaces through a small turn", () => {
    const a = capture(camera(0)), b = capture(camera(2, 10));
    const args = [{ view: a.view, image: a.render, depth: a.depth }, { view: b.view, render: b.render, depth: b.depth }] as const;
    const out = warpKeyframe(...args), unmasked = warpKeyframe(...args, Infinity);
    const geometry = b.hits.filter(Boolean).length;
    expect(b.hits.filter((hit, p) => hit && out.hole[p] && !unmasked.hole[p]).length).toBeLessThanOrEqual(geometry * 0.01);
  });

  it("carries a fine wall texture through a small turn without aliasing", () => {
    // Stripes about 6 px apart in A, on both axes. A turn about the eye maps
    // B to A with no parallax, so every wall pixel in B has an exact stripe colour.
    const stripes = (hit: Vector3) => [128 + 100 * Math.sin(2 * Math.PI * hit.x / 1.5), 128 + 100 * Math.sin(2 * Math.PI * hit.y / 1.5), 128];
    const onWall = (hit: Vector3 | null | undefined) => !!hit && hit.z < -9;
    const a = capture(camera(0)), b = capture(camera(0, 6)), image = a.render.slice();
    a.hits.forEach((hit, p) => { if (onWall(hit)) image.set(stripes(hit!).map(Math.round), p * 4); });
    const out = warpKeyframe({ view: a.view, image, depth: a.depth }, { view: b.view, render: b.render, depth: b.depth });
    let error = 0, count = 0;
    b.hits.forEach((hit, p) => {
      const x = p % W, y = Math.floor(p / W);
      if (out.hole[p] || [-1, 0, 1].some(j => [-1, 0, 1].some(i => !onWall(b.hits[(y + j) * W + x + i]) || x + i < 0 || x + i >= W))) return;
      count++;
      stripes(hit!).forEach((c, k) => { error += Math.abs(out.rgba[p * 4 + k]! - c); });
    });
    // Measured: 3.8 (bilinear softening of the stripes); the old forward splat gave 11.
    expect(count).toBeGreaterThan(1000);
    expect(error / (count * 3)).toBeLessThan(5);
  });

  it("drops a surface A saw at a grazing angle and B sees frontally", () => {
    // A stands 1.5 m from the wall, looking 60 degrees along it; B faces it from 5 m.
    const eyeA = new Vector3(0, 0, -8.5), a = capture(camera(0, -60, 0, 0, eyeA.z)), b = capture(camera(2, 0, 0, 0, -5));
    const args = [{ view: a.view, image: a.render, depth: a.depth }, { view: b.view, render: b.render, depth: b.depth }] as const;
    const out = warpKeyframe(...args), unmasked = warpKeyframe(...args, Infinity);
    // Classes by A's view of each wall point B sees: cos(incidence) = 1.5 m / distance.
    const grazing: number[] = [], frontal: number[] = [];
    b.hits.forEach((hit, p) => {
      if (!hit || unmasked.hole[p]) return; // only pixels the plain warp carries from A
      const cos = 1.5 / hit.distanceTo(eyeA);
      if (cos < 0.3) grazing.push(p); else if (cos > 0.6) frontal.push(p);
    });
    expect(grazing.length).toBeGreaterThan(100);
    expect(frontal.length).toBeGreaterThan(100);
    expect(grazing.filter(p => out.hole[p]).length).toBeGreaterThan(grazing.length * 0.95);
    expect(frontal.filter(p => out.hole[p]).length).toBeLessThan(frontal.length * 0.05);
    for (const p of grazing) if (out.hole[p]) expect(rgbEqual(out.rgba, b.render, p)).toBe(true);
    expect(out.holeShare).toBeGreaterThan(unmasked.holeShare);
  });

  // Raised and pitched down, B sees the box top A never saw; a y-flip in the
  // warp cancels for sideways moves but not here. A's depth matches the top's
  // first row within tolerance, but A sees that face from behind (measured:
  // 0 of 80 top-face px kept, 98.6% of unseen px are holes; sideways 98.3%).
  it.each([
    ["shifts sideways", camera(5), (hit: Vector3) => Math.abs(hit.x - 1) < 1e-6],
    ["rises and pitches down", camera(0, 0, 2.5, -15), (hit: Vector3) => Math.abs(hit.y - 1) < 1e-6],
  ])("opens holes behind a box and on its unseen face when the camera %s", (_, camB, unseenFace) => {
    const camA = camera(0), a = capture(camA), b = capture(camB);
    // A painted copy that differs from B's render everywhere, so warped pixels are traceable.
    const painted = a.render.map((c, i) => (i % 4 === 3 ? c : 255 - c));
    const out = warpKeyframe({ view: a.view, image: painted, depth: a.depth }, { view: b.view, render: b.render, depth: b.depth });
    // Truth: a B pixel is unseen when its surface point is outside A's frame or blocked from A's eye.
    const eyeA = new Vector3(0, 0, 0), unseen = new Uint8Array(W * H);
    let geometry = 0;
    for (let p = 0; p < W * H; p++) {
      const hit = b.hits[p];
      if (!hit) continue;
      geometry++;
      const ray = new Ray(eyeA, hit.clone().sub(eyeA).normalize());
      const first = ray.intersectBox(BOX, new Vector3()), ndc = hit.clone().project(camA);
      if (first && first.distanceTo(eyeA) < hit.distanceTo(eyeA) - 0.05 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) unseen[p] = 1;
    }
    const near = (p: number, r: number) => {
      const x = p % W, y = Math.floor(p / W);
      for (let j = Math.max(0, y - r); j <= Math.min(H - 1, y + r); j++)
        for (let i = Math.max(0, x - r); i <= Math.min(W - 1, x + r); i++) if (unseen[j * W + i]) return true;
      return false;
    };
    const expected = b.render.map((c, i) => (i % 4 === 3 ? c : 255 - c));
    let unseenCount = 0, unseenHoles = 0, strayHoles = 0, warped = 0, warpedRight = 0;
    for (let p = 0; p < W * H; p++) {
      if (unseen[p]) { unseenCount++; if (out.hole[p]) unseenHoles++; }
      if (out.hole[p] && b.hits[p] && !near(p, 2)) strayHoles++;
      if (out.hole[p]) expect(rgbEqual(out.rgba, b.render, p)).toBe(true); // holes take B's render
      // A pixel either side absorbs sampling at stripe edges.
      else if (b.hits[p]) { warped++; if ([p - 1, p, p + 1].some(q => rgbEqual(out.rgba, expected, q))) warpedRight++; }
    }
    // B sees a box face in front of wall A did see: B's depth must keep A's wall paint off it.
    const side = b.hits.flatMap((hit, p) => (hit && unseenFace(hit) ? [p] : []));
    expect(side.length).toBeGreaterThan(20);
    expect(side.filter(p => !out.hole[p])).toEqual([]);
    expect(unseenCount).toBeGreaterThan(50);
    expect(unseenHoles / unseenCount).toBeGreaterThan(0.95);
    expect(strayHoles).toBeLessThan(geometry * 0.01);
    expect(warpedRight / warped).toBeGreaterThan(0.95); // A's paint landed on the same surfaces in B
    expect(out.holeShare).toBeCloseTo(unseenCount / geometry, 1);
    expect(out.angleDeg).toBeGreaterThan(5);
  });

  it("paints B's sky from A's row means, from the nearest row where A has none, and leaves it to B without A sky", () => {
    const a = capture(camera(0)), b = capture(camera(0, 0, 0, 15)); // B looks up: its sky reaches rows where A sees wall
    const bArgs = { view: b.view, render: b.render, depth: b.depth };
    const out = warpKeyframe({ view: a.view, image: a.render, depth: a.depth }, bArgs);
    const rows = skyRows(a.render, a.hits), skyA = new Set(a.hits.flatMap((hit, p) => (hit ? [] : [Math.floor(p / W)])));
    const sky = b.hits.flatMap((hit, p) => (hit ? [] : [p]));
    expect(sky.some(p => !skyA.has(Math.floor(p / W)))).toBe(true);
    for (const p of sky) {
      expect([out.sky[p], out.hole[p]]).toEqual([1, 0]);
      expect([...out.rgba.subarray(p * 4, p * 4 + 4)]).toEqual(rows[Math.floor(p / W)]);
    }
    const blind = warpKeyframe({ view: a.view, image: a.render, depth: a.depth.map(v => v || 1) }, bArgs); // A without sky
    for (const p of sky) { expect([blind.sky[p], blind.hole[p]]).toEqual([0, 1]); expect(rgbEqual(blind.rgba, b.render, p)).toBe(true); }
    expect(blind.holeShare).toBe(out.holeShare); // sky holes are not geometry holes
  });
});

describe("gateTruth", () => {
  const table = [{ object_id: "inn", rgb: [1, 2, 3] as [number, number, number] },
    { object_id: "tree", rgb: [4, 5, 6] as [number, number, number] },
    { object_id: "shed", rgb: [7, 8, 9] as [number, number, number] }];
  const scene = [{ id: "inn", kind: "tavern" as const }, { id: "tree", kind: "tree" as const }, { id: "shed", kind: "mesh" as const, mesh_role: "exterior" as const }];
  const paint = (boxes: [number, number, number, number, number][]) => {
    const px = new Uint8Array(W * H * 4).fill(0);
    for (let p = 0; p < W * H; p++) px[p * 4 + 3] = 255;
    for (const [k, x0, y0, x1, y1] of boxes) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px.set([...table[k]!.rgb, 255], (y * W + x) * 4);
    return px;
  };

  it("picks the largest visible building and ignores bigger non-buildings", () => {
    const truth = gateTruth(paint([[1, 0, 0, 40, 40], [0, 40, 10, 50, 20], [2, 50, 30, 64, 48]]), W, H, table, scene);
    expect(truth?.object_id).toBe("shed");
    expect(truth?.box).toEqual([50 / W, 30 / H, 1, 1]);
    expect(truth?.mask.reduce((s, v) => s + v, 0)).toBe(14 * 18);
  });

  it("returns null when no building covers 1% of the frame", () => {
    expect(gateTruth(paint([[1, 0, 0, 40, 40], [0, 0, 0, 5, 5]]), W, H, table, scene)).toBeNull();
  });
});

describe("pickCandidate", () => {
  const rect = (x0: number, y0: number, w: number, h: number) => {
    const m = new Uint8Array(W * H);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m[y * W + x] = 1;
    return m;
  };
  const truth = rect(20, 12, 20, 20);
  const gate = { centre: 0.03, area: [0.8, 1.2] as [number, number], minPainted: 10 };

  it("passes the first candidate that fits and is painted", () => {
    const pick = pickCandidate(truth, [rect(26, 12, 20, 20), rect(20, 12, 20, 20), rect(21, 12, 20, 20)], [40, 2, 40], W, H, gate);
    expect(pick.index).toBe(2);
    expect(pick.passed).toBe(true);
    expect(pick.metrics.map(m => m.passed)).toEqual([false, false, true]);
  });

  it("keeps the best when nothing passes", () => {
    const pick = pickCandidate(truth, [rect(28, 12, 20, 20), rect(25, 12, 20, 20)], [40, 40], W, H, gate);
    expect(pick).toMatchObject({ index: 1, passed: false });
    expect(pick.metrics[1]!.match!.iou).toBeGreaterThan(pick.metrics[0]!.match!.iou);
  });

  it("treats an empty segmenter mask as a failed measurement, not a zero", () => {
    const empty = new Uint8Array(W * H);
    expect(pickCandidate(truth, [empty, rect(20, 12, 20, 20)], [40, 40], W, H, gate)).toMatchObject({ index: 1, passed: true });
    const alone = pickCandidate(truth, [empty], [40], W, H, gate);
    expect(alone).toMatchObject({ index: 0, passed: false });
    expect(alone.metrics[0]!.match).toBeNull();
  });

  it("breaks ties between chain candidates by agreement with the source, not overlap, and keeps the gate", () => {
    // 0 overlaps best, 1 agrees best among the passes, 2 agrees best of all but is off-centre.
    const masks = [rect(20, 12, 20, 20), rect(21, 12, 20, 20), rect(26, 12, 20, 20)];
    expect(pickCandidate(truth, masks, [40, 40, 40], W, H, gate).index).toBe(0);
    const chain = pickCandidate(truth, masks, [40, 40, 40], W, H, gate, [30, 8, 2]);
    expect(chain).toMatchObject({ index: 1, passed: true });
    expect(chain.metrics.map(m => m.passed)).toEqual([true, true, false]);
  });

  it("skips the paint check when nothing in the input was render", () => {
    expect(pickCandidate(truth, [rect(20, 12, 20, 20)], [null], W, H, gate).passed).toBe(true);
  });
});

describe("paintedDelta", () => {
  const render = new Uint8Array(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 200));
  const all = new Uint8Array(W * H).fill(1);

  it("rejects an unpainted copy of the render and sees a repaint", () => {
    expect(paintedDelta(render, render.slice(), all)).toBe(0);
    const repaint = render.map((c, i) => (i % 4 === 3 ? c : Math.min(255, c + 30)));
    expect(paintedDelta(render, repaint, all)).toBe(30);
    const pick = pickCandidate(new Uint8Array(W * H).fill(1), [all], [paintedDelta(render, render.slice(), all)], W, H,
      { centre: 0.03, area: [0.8, 1.2], minPainted: 10 });
    expect(pick.passed).toBe(false);
  });

  it("counts only render-derived pixels", () => {
    const half = new Uint8Array(W * H).map((_, p) => (p < W * H / 2 ? 1 : 0));
    const repaintBottom = render.map((c, i) => (i % 4 === 3 || i < W * H * 2 ? c : 255 - c));
    expect(paintedDelta(render, repaintBottom, half)).toBe(0);
    expect(paintedDelta(render, render, new Uint8Array(W * H))).toBeNull();
  });
});

describe("compositeChain", () => {
  it("keeps A's painting and sky where A saw, B's painting in the holes, and blends only 2 px each side of the hole edge", () => {
    // Columns 0-19 are holes; the rest is A's paint (red), with A's sky (cyan) in the top 10 rows.
    const hole = new Uint8Array(W * H).map((_, p) => (p % W < 20 ? 1 : 0));
    const rgba = new Uint8Array(W * H * 4).map((_, i) => {
      const p = i >> 2, c = i & 3;
      return c === 3 ? 255 : hole[p] ? 99 : Math.floor(p / W) < 10 ? [0, 220, 220][c]! : [200, 40, 40][c]!;
    });
    const candidate = new Uint8Array(W * H * 4).map((_, i) => [30, 60, 220, 255][i & 3]!);
    const { rgba: out, share } = compositeChain({ rgba, hole }, candidate, W, H);
    for (let p = 0; p < W * H; p++) {
      const x = p % W, px = [...out.subarray(p * 4, p * 4 + 4)];
      if (x <= 17) expect(px).toEqual([30, 60, 220, 255]);
      else if (x >= 22) expect(px).toEqual(Math.floor(p / W) < 10 ? [0, 220, 220, 255] : [200, 40, 40, 255]);
      else expect(px[2]).toBe(Math.round(rgba[p * 4 + 2]! * (x - 17) / 5 + 220 * (22 - x) / 5)); // a linear ramp across the edge
    }
    expect(share).toBeCloseTo(20 / W, 10);
    expect(rgba[0]).toBe(99); // the inputs are not modified
  });
});
