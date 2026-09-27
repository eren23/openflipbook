import { afterAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { WORLD, direction, poseAt, proposedStep } from "@/app/dev/spatial-transitions/geometry/contract";
import { applyPose, makeWorld } from "@/app/dev/spatial-transitions/geometry/world";

const world = makeWorld();
afterAll(() => world.dispose());

describe("persistent quay geometry", () => {
  it("keeps every camera sample clear of walls and body-height obstacles", () => {
    for (let i = 0; i <= 480; i++) {
      const p = poseAt(i / 24);
      expect(world.canOccupy(p.position), `blocked at ${i / 24}s ${p.position}`).toBe(true);
      if (i) expect(world.canMove(poseAt((i - 1) / 24).position, p.position), `crossed solid at ${i / 24}`).toBe(true);
    }
  });
  it("traverses the doorway in both directions instead of changing scene", () => {
    const crossings: number[] = [];
    for (let i = 1; i <= 480; i++) {
      const a = poseAt((i - 1) / 24).position, b = poseAt(i / 24).position;
      if ((a[0] - WORLD.shop.front) * (b[0] - WORLD.shop.front) < 0) {
        crossings.push(i / 24);
        expect(Math.abs(b[2] - WORLD.door.center)).toBeLessThan(WORLD.door.width / 2 - .18);
      }
    }
    expect(crossings).toHaveLength(2);
    expect(crossings[0]).toBeLessThan(10);
    expect(crossings[1]).toBeGreaterThan(12.5);
  });
  it("returns to the exact camera and never changes its FOV", () => {
    expect(poseAt(20)).toEqual(poseAt(0));
    const camera = new THREE.PerspectiveCamera(WORLD.camera.fov, 16 / 9, .08, 100);
    applyPose(camera, poseAt(0)); const start = camera.matrixWorld.toArray();
    applyPose(camera, poseAt(20)); expect(camera.matrixWorld.toArray()).toEqual(start);
    expect(camera.fov).toBe(64);
  });
  it("places the shop to the right and makes a real sideways displacement", () => {
    const camera = new THREE.PerspectiveCamera(WORLD.camera.fov, 16 / 9, .08, 100);
    applyPose(camera, poseAt(0));
    const projected = new THREE.Vector3(...WORLD.landmarks[0]!.position).project(camera);
    expect(projected.x).toBeGreaterThan(0);
    const delta = new THREE.Vector3(...poseAt(2).position).sub(new THREE.Vector3(...poseAt(0).position));
    const forward = new THREE.Vector3(...direction(poseAt(0)));
    const lateral = delta.clone().sub(forward.multiplyScalar(delta.dot(forward)));
    expect(lateral.length()).toBeGreaterThan(.5);
  });
  it("blocks water, walls, barrels and the low counter", () => {
    expect(world.canOccupy([-4, 1.65, 1])).toBe(false);
    expect(world.canOccupy([3.4, 1.65, -1])).toBe(false);
    expect(world.canOccupy([2.86, 1.65, -.45])).toBe(false);
    expect(world.canOccupy([9.8, 1.65, 1])).toBe(false);
    expect(world.canOccupy([3.4, 1.65, 1])).toBe(true);
    expect(world.canMove([8.5, 1.65, 1], [10.8, 1.65, 1])).toBe(false);
  });
  it("uses screen-right for manual strafing, including inside the shop", () => {
    const p = poseAt(10), right = proposedStep(p, 0, .4);
    expect(right.position[0]).toBeCloseTo(p.position[0]);
    expect(right.position[2]).toBeCloseTo(p.position[2] + .4);
  });
  it("keeps scene objects stable across render modes and camera changes", () => {
    const snapshot = world.scene.children.map(n => ({ uuid: n.uuid, position: n.position.toArray() }));
    world.setMode("clay"); world.setMode("illustrated");
    expect(world.scene.children.map(n => ({ uuid: n.uuid, position: n.position.toArray() }))).toEqual(snapshot);
    expect(world.scene.overrideMaterial).toBe(null);
  });
  it("clamps invalid playhead input without NaN camera coordinates", () => {
    expect(poseAt(NaN)).toEqual(poseAt(0));
    expect(poseAt(-2)).toEqual(poseAt(0));
    expect(poseAt(23)).toEqual(poseAt(0));
  });
});
