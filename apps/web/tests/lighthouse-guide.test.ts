import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { contract, makeLighthouse, placeCamera } from "@/app/dev/spatial-transitions/lighthouse/world";

describe("authored lighthouse guide", () => {
  it("preserves standing height and projection during a lateral move and exact return", () => {
    const camera = new THREE.PerspectiveCamera(contract.camera.fov, 16 / 9, .1, 100);
    placeCamera(camera);
    const start = camera.matrixWorld.toArray();
    for (const offset of [-4, -2, 0, 2, 4]) {
      placeCamera(camera, offset);
      expect(camera.position.toArray()).toEqual([12 + offset, 1.65, 24]);
      expect(camera.fov).toBe(39);
      expect(camera.matrixWorld.toArray().every(Number.isFinite)).toBe(true);
    }
    placeCamera(camera);
    expect(camera.matrixWorld.toArray()).toEqual(start);
  });

  it.each([[16 / 9, 39], [390 / 780, 53]])("keeps landmarks framed at aspect %s", (aspect, fov) => {
    const camera = new THREE.PerspectiveCamera(fov, aspect, .1, 100);
    for (const offset of [-4, 0, 4]) {
      placeCamera(camera, offset);
      for (const point of Object.values(contract.landmarks)) {
        const p = new THREE.Vector3(...point as [number, number, number]).project(camera);
        expect(Math.abs(p.x)).toBeLessThan(.95);
        expect(Math.abs(p.y)).toBeLessThan(.95);
        expect(p.z).toBeGreaterThan(-1);
        expect(p.z).toBeLessThan(1);
      }
    }
  });

  it("changes appearance without replacing geometry and disposes GPU resources", () => {
    const world = makeLighthouse();
    const meshes = world.scene.children.filter((n): n is THREE.Mesh => n instanceof THREE.Mesh);
    const initial = meshes.map(n => ({ uuid: n.uuid, geometry: n.geometry, material: n.material }));
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    for (const mode of ["color", "clay", "depth", "color"] as const) {
      world.setMode(mode);
      meshes.forEach((mesh, i) => {
        expect(mesh.uuid).toBe(initial[i]!.uuid);
        expect(mesh.geometry).toBe(initial[i]!.geometry);
        resources.add(mesh.geometry);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) resources.add(material);
      });
    }
    meshes.forEach((mesh, i) => expect(mesh.material).toBe(initial[i]!.material));
    const spies = [...resources].map(resource => vi.spyOn(resource, "dispose"));
    world.dispose();
    spies.forEach(spy => expect(spy).toHaveBeenCalledOnce());
    vi.restoreAllMocks();
  });
});
