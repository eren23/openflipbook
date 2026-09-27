import { expect, it } from "vitest";
import * as THREE from "three";
import { applyRoofMaterials, surfaceUVs } from "./street-materials";
import { ankhStreetScene } from "@/lib/ankh-scene";

it("bakes finite mesh-space UVs without changing vertices or following the camera", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 3));
  mesh.position.set(5, 1, 8); mesh.rotation.z = 0.35;
  const vertices = [...mesh.geometry.getAttribute("position").array];
  surfaceUVs(mesh, "roof");
  const uv = [...mesh.geometry.getAttribute("uv").array];
  expect(uv.every(Number.isFinite)).toBe(true);
  expect(new Set(uv).size).toBeGreaterThan(8);
  expect([...mesh.geometry.getAttribute("position").array]).toEqual(vertices);
  surfaceUVs(mesh, "roof");
  expect([...mesh.geometry.getAttribute("uv").array]).toEqual(uv);
  mesh.geometry.dispose();
});
it("changes only the selected roof using a uniform, without recompiling or moving meshes", () => {
  const definition = ankhStreetScene(), tavern = definition.objects.find(o => o.kind === "tavern")!, house = definition.objects.find(o => o.kind === "house")!;
  const scene = new THREE.Scene();
  const meshes = [tavern, house].map(o => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.userData = { objectId: o.id, surface: "roof" }; scene.add(mesh); return mesh;
  });
  applyRoofMaterials(scene, definition);
  const version = meshes[0]!.material.version, vertices = [...meshes[0]!.geometry.attributes.position!.array];
  const shader = { uniforms: {}, fragmentShader: "#include <map_fragment>" } as unknown as Parameters<THREE.MeshStandardMaterial["onBeforeCompile"]>[0];
  meshes[0]!.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  tavern.roof_material = "teal"; applyRoofMaterials(scene, definition);
  expect(shader.uniforms.ofbRoofTint!.value).toBe(1);
  expect(meshes[1]!.material.userData.roofTint.value).toBe(0);
  expect(meshes[0]!.material.version).toBe(version);
  expect([...meshes[0]!.geometry.attributes.position!.array]).toEqual(vertices);
  tavern.roof_material = "terracotta"; applyRoofMaterials(scene, definition);
  expect(shader.uniforms.ofbRoofTint!.value).toBe(0);
  for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
});
