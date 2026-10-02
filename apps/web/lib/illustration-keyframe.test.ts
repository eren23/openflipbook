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

  it("keeps a thin pole's paint off the wall beside it, and the wall's off the pole", () => {
    // A bright pole 1 px wide, 5 m away, in front of a dark wall at 10 m (the live halo: trees against sky).
    const pole = new Box3(new Vector3(0, -5, -5.06), new Vector3(0.12, 5, -4.94));
    const shoot = (cam: PerspectiveCamera) => {
      const image = new Uint8Array(W * H * 4), depth = new Uint8Array(W * H * 4), onPole = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) {
        const dir = new Vector3((p % W + 0.5) / W * 2 - 1, 1 - (Math.floor(p / W) + 0.5) / H * 2, 0.5).unproject(cam).sub(cam.position).normalize();
        const ray = new Ray(cam.position.clone(), dir), hit = ray.intersectBox(pole, new Vector3()) ?? ray.intersectPlane(WALL, new Vector3())!;
        onPole[p] = hit.z > -9 ? 1 : 0;
        const b = Math.round(255 * (1 - (-hit.applyMatrix4(cam.matrixWorldInverse).z - NEAR) / (FAR - NEAR)));
        image.set(onPole[p] ? [255, 255, 255, 255] : [20, 20, 20, 255], p * 4); depth.set([b, b, b, 255], p * 4);
      }
      const view: KeyframeView = { width: W, height: H, depth: { near: NEAR, far: FAR },
        camera: { projection: "perspective", world_matrix: cam.matrixWorld.toArray(), projection_matrix: cam.projectionMatrix.toArray(), near: 0.1, far: 100 } };
      return { view, image, depth, onPole };
    };
    // 5 cm to the side: the wall moves 0.2 px against the pole, so taps straddle the silhouette.
    const a = shoot(camera(0)), b = shoot(camera(0.05));
    const out = warpKeyframe({ view: a.view, image: a.image, depth: a.depth }, { view: b.view, render: b.image, depth: b.depth });
    const fringe = { wall: 0, pole: 0 };
    let besidePole = 0;
    for (let p = 0; p < W * H; p++) {
      if (out.hole[p]) continue;
      if (out.rgba[p * 4] !== (b.onPole[p] ? 255 : 20)) fringe[b.onPole[p] ? "pole" : "wall"]++;
      if (!b.onPole[p] && (b.onPole[p - 1] || b.onPole[p + 1])) besidePole++;
    }
    expect(fringe).toEqual({ wall: 0, pole: 0 });
    expect(besidePole).toBeGreaterThan(H);
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

describe("warpKeyframe with B's objects", () => {
  // The box is object 0; the wall is ground (-1). A's picture is the inverted render, so A's pixels are traceable.
  const onBox = (hit: Vector3 | null) => !!hit && hit.z > -9;
  const run = (camA: PerspectiveCamera, camB: PerspectiveCamera, object = onBox) => {
    const a = capture(camA), b = capture(camB), image = a.render.map((c, i) => (i % 4 === 3 ? c : 255 - c));
    const objects = Int32Array.from(b.hits, hit => (object(hit) ? 0 : -1)), box = b.hits.flatMap((hit, p) => (object(hit) ? [p] : []));
    const args = [{ view: a.view, image, depth: a.depth }, { view: b.view, render: b.render, depth: b.depth }] as const;
    const plain = warpKeyframe(...args), out = warpKeyframe(args[0], { ...args[1], objects });
    const candidate = new Uint8Array(W * H * 4).map((_, i) => [30, 60, 220, 255][i & 3]!);
    return { b, box, plain, out, candidate, composite: compositeChain(out, candidate, W, H).rgba, capped: (m: number) => warpKeyframe(...args, m) };
  };
  const kept = (warp: { hole: Uint8Array }, box: number[]) => box.filter(p => !warp.hole[p]).length / box.length;
  // On the silhouette of `pixels`: a 4-neighbour lies outside it.
  const edge = (p: number, pixels: number[]) => [p - 1, p + 1, p - W, p + W].some(q => !pixels.includes(q));

  it("takes an object A saw at 2x magnification wholly from A", () => {
    // B stands 2 m from the box's front face, A 4 m: the face is magnified 2x, over the 1.6 limit.
    const { box, plain, out, candidate, composite } = run(camera(0), camera(0, 0, 0, 0, -2));
    expect(box.length).toBeGreaterThan(W * H * 0.4);
    expect(kept(plain, box)).toBeLessThan(0.05);
    expect(out.objects).toEqual({ a: 1, candidate: 0, ground: 0 });
    for (const p of box) {
      // Only the 1 px silhouette, where A's nearest pixel is the wall, is unseen; it is the candidate's alone.
      if (out.hole[p]) { expect(edge(p, box)).toBe(true); expect(rgbEqual(composite, candidate, p)).toBe(true); continue; }
      expect(out.pure![p]).toBe(1);
      expect(rgbEqual(composite, out.rgba, p)).toBe(true);
      expect(rgbEqual(composite, candidate, p)).toBe(false);
    }
  });

  it("takes an object A mostly did not see wholly from the candidate, and leaves the ground as it was", () => {
    // A looks 45 degrees left: it saw only the box's right edge.
    const { b, box, plain, out, candidate, composite } = run(camera(0, 45), camera(0));
    expect(kept(plain, box)).toBeGreaterThan(0.1);
    expect(kept(plain, box)).toBeLessThan(0.6);
    expect(out.objects).toEqual({ a: 0, candidate: 1, ground: 0 });
    for (const p of box) expect(rgbEqual(composite, candidate, p)).toBe(true);
    b.hits.forEach((hit, p) => {
      if (onBox(hit)) return;
      expect([out.hole[p], out.pure![p], rgbEqual(out.rgba, plain.rgba, p)]).toEqual([plain.hole[p], 0, true]);
    });
  });

  it("mixes sources inside an A-sourced object only where A did not see it", () => {
    // B, 1.5 m right and 2 m nearer, sees the box's right face, which A never saw.
    const { b, box, out, candidate, composite } = run(camera(0), camera(1.5, 0, 0, 0, -2));
    const side = box.filter(p => Math.abs(b.hits[p]!.x - 1) < 1e-6);
    expect(side.length).toBeGreaterThan(20);
    expect(out.objects).toEqual({ a: 1, candidate: 0, ground: 0 });
    for (const p of side) expect(rgbEqual(composite, candidate, p)).toBe(true);
    for (const p of box) expect(rgbEqual(composite, out.hole[p] ? candidate : out.rgba, p)).toBe(true);
    const front = box.filter(p => !side.includes(p));
    expect(front.filter(p => out.hole[p] && !edge(p, front))).toEqual([]);
  });

  it("still leaves to the candidate the face of an A-sourced object that A saw almost edge-on", () => {
    // A stands 0.3 m outside the plane of the box's right face; B looks at that face from 2 m right of it.
    const { b, box, out, candidate, composite, capped } = run(camera(1.3), camera(3, 20, 0, 0, -2));
    expect(out.objects).toEqual({ a: 1, candidate: 0, ground: 0 });
    const side = box.filter(p => Math.abs(b.hits[p]!.x - 1) < 1e-6), front = box.filter(p => Math.abs(b.hits[p]!.z + 4) < 1e-6);
    expect(side.filter(p => !capped(Infinity).hole[p]).length).toBeGreaterThan(side.length / 2); // A did see most of it
    for (const p of side) expect(rgbEqual(composite, candidate, p)).toBe(true);
    expect(front.filter(p => out.pure![p] && !out.hole[p]).length).toBeGreaterThan(front.length * 0.95);
  });

  it("cuts an A-sourced wall that recedes past 3x in one clean line, not in stripes", () => {
    // Only the wall, as one object. A, 2 m from it, looks 50 degrees along it; B looks at it 20 degrees right.
    // Without the majority rule the 8-bit depth steps left 1-3 px stripes of A's paint inside the cut part.
    const shoot = (cam: PerspectiveCamera) => {
      const render = new Uint8Array(W * H * 4).fill(128), depth = new Uint8Array(W * H * 4).fill(255), hits: boolean[] = [];
      for (let p = 0; p < W * H; p++) {
        const dir = new Vector3((p % W + 0.5) / W * 2 - 1, 1 - (Math.floor(p / W) + 0.5) / H * 2, 0.5).unproject(cam).sub(cam.position).normalize();
        const hit = new Ray(cam.position.clone(), dir).intersectPlane(WALL, new Vector3()), z = hit ? -hit.applyMatrix4(cam.matrixWorldInverse).z : 0;
        hits.push(z > 0 && z <= FAR);
        depth.fill(hits[p] ? Math.round(255 * (1 - (z - NEAR) / (FAR - NEAR))) : 0, p * 4, p * 4 + 3);
      }
      const view: KeyframeView = { width: W, height: H, depth: { near: NEAR, far: FAR },
        camera: { projection: "perspective", world_matrix: cam.matrixWorld.toArray(), projection_matrix: cam.projectionMatrix.toArray(), near: 0.1, far: 100 } };
      return { view, render, depth, hits };
    };
    const a = shoot(camera(0, -50, 0, 0, -8)), b = shoot(camera(2, -20, 0, 0, -4));
    const args = [{ view: a.view, image: a.render, depth: a.depth }, { view: b.view, render: b.render, depth: b.depth }] as const;
    const out = warpKeyframe(args[0], { ...args[1], objects: Int32Array.from(b.hits, hit => (hit ? 0 : -1)) }), seen = warpKeyframe(...args, Infinity);
    expect(out.objects).toEqual({ a: 1, candidate: 0, ground: 0 });
    let cut = 0;
    for (let y = 0; y < H; y++) {
      // Along each row, over the pixels A saw: A's paint, then at most one switch to the candidate.
      const row = Array.from({ length: W }, (_, x) => y * W + x).filter(p => b.hits[p] && !seen.hole[p]).map(p => out.hole[p]!);
      cut += row.filter(v => v).length;
      expect(row.filter((v, i) => i && v !== row[i - 1]).length).toBeLessThanOrEqual(1);
    }
    expect(cut).toBeGreaterThan(300);
  });

  it("keeps the per-pixel rule for a flat object", () => {
    // Both eyes above the box: its top is flat, so it counts as ground.
    const top = (hit: Vector3 | null) => !!hit && Math.abs(hit.y - 1) < 1e-6;
    const { box, plain, out } = run(camera(0, 0, 3, -20), camera(0.5, 0, 2.5, -15), top);
    expect(box.length).toBeGreaterThan(50);
    expect(out.objects).toEqual({ a: 0, candidate: 0, ground: 1 });
    expect(out.pure!.every(v => !v)).toBe(true);
    expect([out.hole, out.rgba]).toEqual([plain.hole, plain.rgba]);
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
  it("judges each object that takes 5% of the frame on its own", () => {
    const render = new Uint8Array(W * H * 4).fill(100), mask = new Uint8Array(W * H).fill(1);
    // Object 0 (10% of the frame) and object 1 (3%) keep the render; everything else is repainted by 60.
    const objects = Int32Array.from({ length: W * H }, (_, p) => (p < W * H * 0.1 ? 0 : p < W * H * 0.13 ? 1 : -1));
    const candidate = render.map((c, i) => (objects[i >> 2]! >= 0 || i % 4 === 3 ? c : c + 60));
    expect(paintedDelta(render, candidate, mask)).toBeGreaterThan(50);
    expect(paintedDelta(render, candidate, mask, objects)).toBe(0);
    objects.fill(-1, 0, W * H * 0.1);
    expect(paintedDelta(render, candidate, mask, objects)).toBeGreaterThan(50); // 3% alone is not judged
  });

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
  it("keeps A's painting and sky where A saw, B's painting in the holes, and blends only 2 px on A's side of the hole edge", () => {
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
      if (x < 20) expect(px).toEqual([30, 60, 220, 255]); // B's render (99) never shows
      else if (x >= 22) expect(px).toEqual(Math.floor(p / W) < 10 ? [0, 220, 220, 255] : [200, 40, 40, 255]);
      else expect(px[2]).toBe(Math.round(rgba[p * 4 + 2]! * (x - 17) / 5 + 220 * (22 - x) / 5)); // a linear ramp into A's side
    }
    expect(share).toBeCloseTo((20 + 0.6) / W, 10);
    // A pure pixel is A's alone, next to a hole or not.
    const pure = new Uint8Array(W * H).map((_, p) => (p % W === 20 ? 1 : 0));
    expect(compositeChain({ rgba, hole, pure }, candidate, W, H).rgba.subarray(20 * 4, 20 * 4 + 4)).toEqual(rgba.subarray(20 * 4, 20 * 4 + 4));
    expect(rgba[0]).toBe(99); // the inputs are not modified
  });
});
