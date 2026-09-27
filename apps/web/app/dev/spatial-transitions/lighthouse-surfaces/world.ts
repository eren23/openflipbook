import * as THREE from "three";
import { makeWorld as makeBaseline } from "../lighthouse-v2/world";
import appearance from "./appearance.json";

export { appearance };
export type SurfaceMode = "surface" | "baseline" | "clay";
type Treatment = "stone" | "radial" | "crystal" | "plain";

// Every pattern is evaluated in mesh-local coordinates. No camera, frame or time inputs.
export const SURFACE_GLSL = `
varying vec3 surfacePosition;
varying vec3 surfaceNormal;
float surfaceHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
vec3 stoneSurface(vec2 p, vec3 base) {
  float row = floor(p.y / 0.48);
  vec2 grid = vec2(p.x / 0.9 + mod(row, 2.0) * 0.5, p.y / 0.48);
  vec2 cell = floor(grid), f = fract(grid);
  float seed = surfaceHash(cell);
  vec2 aa = max(fwidth(grid), vec2(0.005));
  float horizontal = 1.0 - smoothstep(0.018, 0.018 + aa.y, min(f.y, 1.0-f.y));
  float vertical = 1.0 - smoothstep(0.022, 0.022 + aa.x, min(f.x, 1.0-f.x));
  float mortar = max(horizontal * step(0.2, seed), vertical * step(0.35, seed));
  float fleck = surfaceHash(floor(p * 45.0));
  vec3 stone = base * (0.89 + seed * 0.17 + fleck * 0.025);
  return mix(stone, base * vec3(0.43,0.39,0.45), mortar * 0.65);
}
`;

function shaderMaterial(color: string, treatment: Treatment, gradient: THREE.DataTexture) {
  const material = treatment === "crystal" ? new THREE.MeshBasicMaterial({ color: "#88e5f1" })
    : new THREE.MeshToonMaterial({ color, gradientMap: gradient });
  material.customProgramCacheKey = () => `lighthouse-surface-1:${treatment}`;
  material.onBeforeCompile = shader => {
    shader.vertexShader = `varying vec3 surfacePosition; varying vec3 surfaceNormal;\n${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nsurfacePosition = position; surfaceNormal = normal;");
    shader.fragmentShader = SURFACE_GLSL + shader.fragmentShader;
    const p = treatment === "radial" ? "vec2(atan(surfacePosition.z, surfacePosition.x) * 2.0, surfacePosition.y)" : "vec2(abs(surfaceNormal.x) > 0.6 ? surfacePosition.z : surfacePosition.x, surfacePosition.y)";
    const colorCode = treatment === "stone" || treatment === "radial"
      ? `diffuseColor.rgb = stoneSurface(${p}, diffuseColor.rgb); diffuseColor.rgb *= mix(vec3(1.07,1.0,0.87),vec3(0.76,0.82,1.08),clamp(surfaceNormal.x*0.9,0.0,1.0));`
      : treatment === "crystal"
        ? "diffuseColor.rgb = mix(vec3(0.16,0.72,0.8), vec3(0.5,0.32,0.8), step(0.0,surfaceNormal.x) * 0.65); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72,0.98,1.0), max(surfaceNormal.y,0.0));"
        : "";
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>\n${colorCode}`);
  };
  return material;
}

export function makeWorld() {
  const base = makeBaseline();
  const gradient = new THREE.DataTexture(new Uint8Array([95, 145, 195, 255]), 4, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter; gradient.needsUpdate = true;
  const replacements = new Map<THREE.Mesh, THREE.Material>();
  const palette = appearance.palette;
  base.scene.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const name = node.name;
    const isCrystal = name === "crystal" || name.startsWith("shard");
    const radial = ["shaft", "base-lower", "base-upper"].includes(name);
    const stone = radial || ["arcade", "annex-end", "annex-rear"].includes(name);
    const color = name === "annex-roof" ? palette.roof : name === "assumed-ground" ? palette.ground : name === "annex-rear" ? "#667991"
      : name === "front-recess" ? palette.recess : name.includes("band") ? palette.band : palette.stone;
    replacements.set(node, shaderMaterial(color, isCrystal ? "crystal" : radial ? "radial" : stone ? "stone" : "plain", gradient));
  });
  const lines = new Map<THREE.LineBasicMaterial, THREE.Color>();
  const legacyCourses: THREE.LineSegments[] = [];
  base.scene.traverse(node => {
    if (node instanceof THREE.LineSegments && node.material instanceof THREE.LineBasicMaterial) {
      lines.set(node.material, node.material.color.clone());
      if (node.parent === base.scene) {
        node.geometry.computeBoundingBox();
        if (node.geometry.boundingBox!.max.y > 8) legacyCourses.push(node);
      }
    }
  });
  const lights = base.scene.children.filter((n): n is THREE.Light => n instanceof THREE.Light).map(light => ({ light, intensity: light.intensity, color: light.color.clone() }));
  let active: SurfaceMode | undefined;
  function setMode(mode: SurfaceMode) {
    if (mode === active) return;
    active = mode;
    base.setMode(mode === "clay" ? "clay" : "color");
    legacyCourses.forEach(line => { line.visible = mode !== "surface"; });
    lines.forEach((color, material) => material.color.copy(mode === "surface" ? new THREE.Color(palette.ink) : color));
    lights.forEach(({ light, intensity, color }) => {
      light.intensity = mode === "surface" ? (light instanceof THREE.HemisphereLight ? 1.65 : 2.0) : intensity;
      light.color.copy(mode === "surface" ? new THREE.Color(light instanceof THREE.HemisphereLight ? "#cedbf5" : "#fff2e0") : color);
    });
    if (mode === "surface") {
      replacements.forEach((material, mesh) => { mesh.material = material; });
      base.scene.background = new THREE.Color(palette.sky);
    }
  }
  setMode("surface");
  return { scene: base.scene, setMode, dispose() { replacements.forEach(m => m.dispose()); gradient.dispose(); base.dispose(); } };
}
