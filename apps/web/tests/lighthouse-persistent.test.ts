import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { applyCamera, canTraverse, INITIAL, poseAt, readSnapshot, WORLD } from "@/app/dev/spatial-transitions/lighthouse-v2/contract";
import { makeWorld } from "@/app/dev/spatial-transitions/lighthouse-v2/world";

describe("persistent lighthouse v2", () => {
  it("binds its evidence to the original crop, not a generated replacement", () => {
    const crop = readFileSync("app/dev/spatial-transitions/lighthouse-v2/reference.png");
    expect(createHash("sha256").update(crop).digest("hex")).toBe(WORLD.source.sha256);
    expect(WORLD.features.map(f => f.id)).toEqual(["base", "annex", "crown", "crystal"]);
    expect(WORLD.features.every(f => f.observed && f.assumed)).toBe(true);
  });
  it("keeps the entire sampled route outside conservative building envelopes", () => {
    for (let i = 0; i < 24 * 60; i++) {
      const a = poseAt(i / 60), b = poseAt((i + 1) / 60);
      expect(canTraverse(a.position, b.position), `blocked at ${i / 60}`).toBe(true);
      expect(a.position[1]).toBe(1.65);
    }
  });
  it("rejects wall crossings, occupied starts, flight, invalid coordinates and leaving the assumed ground", () => {
    expect(canTraverse([0, 1.65, 7], [0, 1.65, -7])).toBe(false);
    expect(canTraverse([5, 1.65, 0], [5, 1.65, 7])).toBe(false);
    expect(canTraverse([5, 2, 7], [6, 2, 7])).toBe(false);
    expect(canTraverse([NaN, 1.65, 7], [6, 1.65, 7])).toBe(false);
    expect(canTraverse([5, 1.65, 7], [36, 1.65, 7])).toBe(false);
  });
  it("translates the camera without zooming and returns to the exact matrix", () => {
    const camera = new THREE.PerspectiveCamera(WORLD.camera.fov, 16 / 9, .1, 120);
    applyCamera(camera, 0, "walk"); const start = camera.matrixWorld.toArray();
    applyCamera(camera, 6, "walk"); expect(camera.matrixWorld.toArray()).not.toEqual(start);
    expect(poseAt(6).position[0] - poseAt(0).position[0]).toBe(-8);
    expect(camera.fov).toBe(45);
    applyCamera(camera, 24, "walk"); expect(camera.matrixWorld.toArray()).toEqual(start);
    expect(poseAt(NaN)).toEqual(poseAt(0));
  });
  it("has open arch bays and an open crown, not dark painted rectangles", () => {
    const world = makeWorld(); world.scene.updateMatrixWorld(true);
    const arcade = world.scene.getObjectByName("arcade")!;
    const cast = (x: number, y: number) => new THREE.Raycaster(new THREE.Vector3(x, y, 7), new THREE.Vector3(0, 0, -1)).intersectObject(arcade, false);
    for (const x of WORLD.annex.bays) expect(cast(x, 1)).toHaveLength(0);
    expect(cast(4.65, 1).length).toBeGreaterThan(0);
    expect(cast(5.7, 2.9).length).toBeGreaterThan(0);
    const down = new THREE.Raycaster(new THREE.Vector3(0, 11, 0), new THREE.Vector3(0, -1, 0));
    expect(down.intersectObject(world.scene.getObjectByName("open-crown")!, false)).toHaveLength(0);
    expect(down.intersectObject(world.scene.getObjectByName("basin")!, false).length).toBeGreaterThan(0);
    expect(world.scene.children.filter(n => n.name.startsWith("crown-arm"))).toHaveLength(2);
    world.dispose();
  });
  it("keeps geometry stable across modes and independent builds and frees GPU resources", () => {
    const first = makeWorld(), second = makeWorld();
    const shape = (world: ReturnType<typeof makeWorld>) => world.scene.children.filter((n): n is THREE.Mesh => n instanceof THREE.Mesh).map(n => ({ name: n.name, position: n.position.toArray(), scale: n.scale.toArray(), vertices: Array.from(n.geometry.getAttribute("position").array) }));
    const original = shape(first); expect(shape(second)).toEqual(original);
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    for (const mode of ["color", "clay", "depth", "color"] as const) {
      first.setMode(mode);
      first.scene.traverse(n => {
        if (n instanceof THREE.Mesh || n instanceof THREE.LineSegments) {
          resources.add(n.geometry);
          for (const m of Array.isArray(n.material) ? n.material : [n.material]) resources.add(m);
        }
      });
      expect(shape(first)).toEqual(original);
    }
    const spies = [...resources].map(r => vi.spyOn(r, "dispose")); first.dispose();
    spies.forEach(s => expect(s).toHaveBeenCalledOnce()); second.dispose(); vi.restoreAllMocks();
  });
  it.each([null, "broken", "null", "[]", '{"version":1}', JSON.stringify({ ...INITIAL, time: 25 }), JSON.stringify({ ...INITIAL, mode: "invalid" }), JSON.stringify({ ...INITIAL, view: "inside" })])("rejects incompatible saved camera state: %s", raw => {
    expect(readSnapshot(raw)).toEqual(INITIAL);
  });
  it("restores only the known version and safe camera fields", () => {
    expect(readSnapshot(JSON.stringify({ ...INITIAL, time: 12, mode: "clay", extra: "ignored" }))).toEqual({ ...INITIAL, time: 12, mode: "clay" });
  });
});
