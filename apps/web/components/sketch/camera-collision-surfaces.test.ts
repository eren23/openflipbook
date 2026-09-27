import { expect, it } from "vitest";
import { BoxGeometry, Group, InstancedMesh, Mesh, MeshBasicMaterial, Scene } from "three";
import { cameraCollisionSurfaces } from "./camera-collision-surfaces";

it("resolves parent transforms and identities, including hidden-parent and transparent state", () => {
  const scene = new Scene(), parent = new Group(), geometry = new BoxGeometry(2, 2, 2), material = new MeshBasicMaterial();
  parent.position.set(10, 4, 2); parent.userData.sceneObjectId = "building"; scene.add(parent);
  const mesh = new Mesh(geometry, material); mesh.position.x = 3; parent.add(mesh);
  try {
    const surfaces = cameraCollisionSurfaces(scene);
    expect(surfaces).toHaveLength(1); expect(surfaces[0]!.object_id).toBe("building"); expect(surfaces[0]!.occludes).toBe(true);
    const xs = [...surfaces[0]!.vertices].filter((_, i) => i % 3 === 0); expect(Math.min(...xs)).toBe(12); expect(Math.max(...xs)).toBe(14);
    material.transparent = true; expect(cameraCollisionSurfaces(scene)[0]!.occludes).toBe(false);
    parent.visible = false; expect(cameraCollisionSurfaces(scene)).toEqual([]);
  } finally { geometry.dispose(); material.dispose(); }
});
it("rejects unsupported and nonfinite visible geometry instead of skipping it", () => {
  const scene = new Scene(), geometry = new BoxGeometry(), material = new MeshBasicMaterial(), mesh = new InstancedMesh(geometry, material, 1); scene.add(mesh);
  try {
    expect(() => cameraCollisionSurfaces(scene)).toThrow(/instanced/);
    scene.remove(mesh); const plain = new Mesh(geometry, material); scene.add(plain); plain.position.x = Infinity;
    expect(() => cameraCollisionSurfaces(scene)).toThrow(/Invalid/);
    plain.position.x = 0; geometry.setIndex([0, 1, 100000]);
    expect(() => cameraCollisionSurfaces(scene)).toThrow(/indices/);
  } finally { geometry.dispose(); material.dispose(); }
});
