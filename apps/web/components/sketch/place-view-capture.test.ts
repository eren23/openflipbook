import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { capturePlaceView } from "./place-view-capture";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
import type { ViewSource } from "@/lib/place-view";

afterEach(() => vi.restoreAllMocks());
function fixture(fail = false) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color("#abcabc");
  const object = newComponent("volume", 0, 0), material = new THREE.MeshStandardMaterial({ color: "#bc5678" });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), material); mesh.userData.objectId = object.id; scene.add(mesh);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ transparent: true, opacity: .3 })); scene.add(glass);
  const helper = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial()); scene.add(helper);
  const camera = new THREE.PerspectiveCamera(60, 1, .1, 100); camera.position.set(4, 5, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const oldTarget = new THREE.WebGLRenderTarget(1, 1); let current = oldTarget;
  const renders: { target: THREE.WebGLRenderTarget; helper: boolean; material: THREE.Material; glassVisible: boolean }[] = [];
  const renderer = { outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.ACESFilmicToneMapping, shadowMap: { enabled: true },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 64), getRenderTarget: () => current,
    setRenderTarget: (target: THREE.WebGLRenderTarget) => { current = target; }, clear: () => {},
    render: () => { renders.push({ target: current, helper: helper.visible, material: mesh.material, glassVisible: glass.material.visible }); if (fail && renders.length === 2) throw new Error("GPU lost"); },
    readRenderTargetPixels: (_target: unknown, _x: number, _y: number, _w: number, _h: number, pixels: Uint8Array) => { pixels.fill(127); },
  };
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const element = create(tag);
    if (tag === "canvas") {
      Object.defineProperty(element, "getContext", { value: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) });
      Object.defineProperty(element, "toDataURL", { value: () => "data:image/png;base64,fixture" });
    }
    return element;
  });
  const sources: ViewSource[] = [{ scene_id: "scene", place_id: "place", revision: 1, x: 0, z: 0, definition: { ...emptyPlaceScene(), objects: [object] } }];
  return { scene, material, mesh, glass, helper, camera, renderer, sources, oldTarget, renders,
    capture: () => capturePlaceView(renderer as unknown as THREE.WebGLRenderer, scene, camera, sources, "orbit") };
}
it("uses separate sRGB/data targets and restores live material, helper and renderer state", () => {
  const f = fixture(), background = f.scene.background, camera = f.camera.matrixWorld.clone();
  const disposeMaterial = vi.spyOn(THREE.Material.prototype, "dispose"), disposeTarget = vi.spyOn(THREE.WebGLRenderTarget.prototype, "dispose");
  const result = f.capture();
  expect(f.renders).toHaveLength(4); expect(f.renders[0]!.target.texture.colorSpace).toBe(THREE.SRGBColorSpace);
  expect(f.renders[1]!.target).not.toBe(f.renders[0]!.target);
  expect(f.renders.slice(1).every(r => r.target === f.renders[1]!.target && r.target.texture.colorSpace === THREE.NoColorSpace)).toBe(true);
  expect(f.renders.every(r => !r.helper)).toBe(true); expect(f.renders[0]!.glassVisible).toBe(true); expect(f.renders.slice(1).every(r => !r.glassVisible)).toBe(true);
  expect(f.mesh.material).toBe(f.material); expect(f.helper.visible).toBe(true); expect(f.scene.background).toBe(background);
  expect(f.renderer.getRenderTarget()).toBe(f.oldTarget); expect(f.renderer.outputColorSpace).toBe(THREE.SRGBColorSpace); expect(f.renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping); expect(f.renderer.shadowMap.enabled).toBe(true);
  expect(f.camera.matrixWorld).toEqual(camera); expect(result.sources).toEqual(f.sources); expect(result.surface_policy).toBe("opaque_geometry");
  expect(disposeTarget).toHaveBeenCalledTimes(2); expect(disposeMaterial).toHaveBeenCalledTimes(6);
});
it("restores live state and releases temporary targets even when a data render throws", () => {
  const f = fixture(true), background = f.scene.background, disposeTarget = vi.spyOn(THREE.WebGLRenderTarget.prototype, "dispose");
  expect(f.capture).toThrow("GPU lost"); expect(f.mesh.material).toBe(f.material); expect(f.helper.visible).toBe(true); expect(f.glass.material.visible).toBe(true);
  expect(f.scene.background).toBe(background); expect(f.renderer.getRenderTarget()).toBe(f.oldTarget); expect(f.renderer.shadowMap.enabled).toBe(true); expect(disposeTarget).toHaveBeenCalledTimes(2);
});
it("fails explicitly for alpha-cutout surfaces before altering the live scene", () => {
  const f = fixture(); f.material.alphaTest = .5;
  expect(f.capture).toThrow("cutout"); expect(f.renders).toHaveLength(0); expect(f.mesh.material).toBe(f.material); expect(f.helper.visible).toBe(true);
});
it("captures at the saved pixel size instead of the resized live drawing buffer", () => {
  const f = fixture();
  const result = capturePlaceView(f.renderer as unknown as THREE.WebGLRenderer, f.scene, f.camera, f.sources, "orbit", undefined, { width: 711, height: 419 });
  expect(result.width).toBe(711); expect(result.height).toBe(419);
  expect(f.renders.every(r => r.target.width === 711 && r.target.height === 419)).toBe(true);
  expect(f.renderer.getRenderTarget()).toBe(f.oldTarget);
});
it("rejects invalid output sizes before changing renderer state", () => {
  const f = fixture();
  for (const width of [0, 31, 1025, Infinity, 32.5]) expect(() => capturePlaceView(f.renderer as unknown as THREE.WebGLRenderer, f.scene, f.camera, f.sources, "orbit", undefined, { width, height: 64 })).toThrow("dimensions");
  expect(f.renders).toHaveLength(0);
});
it("passes top-left-oriented object pixels to measurement once and cleans up if measurement fails", () => {
  const f = fixture(), measured = vi.fn();
  f.renderer.readRenderTargetPixels = (_target, _x, _y, width, height, pixels) => {
    pixels.fill(0);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[(y * width + x) * 4] = y;
  };
  capturePlaceView(f.renderer as unknown as THREE.WebGLRenderer, f.scene, f.camera, f.sources, "orbit", undefined, undefined, measured);
  expect(measured).toHaveBeenCalledTimes(1);
  const [pixels, width, height] = measured.mock.calls[0]!;
  expect([width, height]).toEqual([64, 64]);
  expect(pixels[0]).toBe(63); expect(pixels[(63 * 64) * 4]).toBe(0);
  expect(() => capturePlaceView(f.renderer as unknown as THREE.WebGLRenderer, f.scene, f.camera, f.sources, "orbit", undefined, undefined, () => { throw new Error("Invalid mask"); })).toThrow("Invalid mask");
  expect(f.mesh.material).toBe(f.material); expect(f.renderer.getRenderTarget()).toBe(f.oldTarget);
});
