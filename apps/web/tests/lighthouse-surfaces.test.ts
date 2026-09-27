import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { makeWorld as makeBaseline } from "@/app/dev/spatial-transitions/lighthouse-v2/world";
import { appearance, makeWorld, SURFACE_GLSL } from "@/app/dev/spatial-transitions/lighthouse-surfaces/world";
import { INITIAL, restore } from "@/app/dev/spatial-transitions/lighthouse-surfaces/state";

function shape(scene: THREE.Scene) {
  return scene.children.filter((node): node is THREE.Mesh => node instanceof THREE.Mesh).map(node => ({
    name: node.name, position: node.position.toArray(), scale: node.scale.toArray(), rotation: node.rotation.toArray(),
    vertices: Array.from(node.geometry.getAttribute("position").array), index: node.geometry.index ? Array.from(node.geometry.index.array) : null,
  }));
}
describe("fixed lighthouse surfaces", () => {
  it("preserves the recorded baseline implementation and source evidence", () => {
    for (const [file, digest] of Object.entries(appearance.baselineHashes)) {
      expect(createHash("sha256").update(readFileSync(`app/dev/spatial-transitions/lighthouse-v2/${file}`)).digest("hex")).toBe(digest);
    }
    expect(appearance.accepted).toBe(false);
  });
  it("changes no vertices, topology or transforms and restores original baseline materials/lights", () => {
    const original = makeBaseline(), pass = makeWorld();
    const expected = shape(original.scene);
    for (const mode of ["surface", "clay", "baseline", "surface", "baseline"] as const) {
      pass.setMode(mode); expect(shape(pass.scene)).toEqual(expected);
    }
    for (const node of original.scene.children) {
      const other = pass.scene.children[original.scene.children.indexOf(node)]!;
      if (node instanceof THREE.Light && other instanceof THREE.Light) {
        expect(other.color.toArray()).toEqual(node.color.toArray()); expect(other.intensity).toBe(node.intensity);
      }
      if (node instanceof THREE.Mesh && other instanceof THREE.Mesh) {
        expect((other.material as THREE.MeshLambertMaterial).color.toArray()).toEqual((node.material as THREE.MeshLambertMaterial).color.toArray());
        expect(other.material.type).toBe(node.material.type);
      }
    }
    expect((pass.scene.background as THREE.Color).getHex()).toBe((original.scene.background as THREE.Color).getHex());
    original.dispose(); pass.dispose();
  });
  it("uses local coordinates with no clock or view-dependent input to the surface pattern", () => {
    expect(SURFACE_GLSL).toContain("surfacePosition");
    expect(SURFACE_GLSL).not.toMatch(/gl_FragCoord|cameraPosition|viewMatrix|uniform\s+float\s+time/);
    const world = makeWorld();
    const material = (world.scene.getObjectByName("shaft") as THREE.Mesh).material as THREE.MeshToonMaterial;
    const shader = { vertexShader: "#include <begin_vertex>", fragmentShader: "#include <color_fragment>" };
    material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("surfacePosition = position");
    expect(shader.fragmentShader).toContain("stoneSurface(");
    expect(material.customProgramCacheKey()).toContain("radial"); world.dispose();
  });
  it("releases all replacement materials and their shared gradient texture", () => {
    const world = makeWorld(), materials: (THREE.MeshToonMaterial | THREE.MeshBasicMaterial)[] = [];
    world.scene.traverse(node => { if (node instanceof THREE.Mesh && (node.material instanceof THREE.MeshToonMaterial || node.material instanceof THREE.MeshBasicMaterial)) materials.push(node.material); });
    const dispose = materials.map(m => vi.spyOn(m, "dispose"));
    const toon = materials.find((m): m is THREE.MeshToonMaterial => m instanceof THREE.MeshToonMaterial)!;
    const texture = vi.spyOn(toon.gradientMap!, "dispose");
    world.dispose(); dispose.forEach(spy => expect(spy).toHaveBeenCalledOnce()); expect(texture).toHaveBeenCalledOnce(); vi.restoreAllMocks();
  });
  it.each([null, "bad", "null", JSON.stringify({ ...INITIAL, asset: "old" }), JSON.stringify({ ...INITIAL, time: 25 }), JSON.stringify({ ...INITIAL, mode: "new" }), JSON.stringify({ ...INITIAL, view: "interior" })])("rejects incompatible saved appearance state %s", raw => {
    expect(restore(raw)).toEqual(INITIAL);
  });
  it("restores only the validated fields in its own asset version", () => {
    expect(restore(JSON.stringify({ ...INITIAL, time: 6, extra: true }))).toEqual({ ...INITIAL, time: 6 });
  });
});
