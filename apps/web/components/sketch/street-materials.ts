import * as THREE from "three";
import type { PlaceSceneDefinition } from "@openflipbook/config";

export function applyRoofMaterials(scene: THREE.Scene, definition: PlaceSceneDefinition) {
  const roofs = new Map(definition.objects.map(object => [object.id, object.roof_material]));
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.surface !== "roof" || !(object.material instanceof THREE.MeshStandardMaterial)) return;
    const teal = roofs.get(object.userData.objectId) === "teal", material = object.material;
    if (material.userData.roofTint) { material.userData.roofTint.value = teal ? 1 : 0; return; }
    const tint = { value: teal ? 1 : 0 }; material.userData.roofTint = tint;
    material.onBeforeCompile = shader => {
      shader.uniforms.ofbRoofTint = tint;
      shader.fragmentShader = "uniform float ofbRoofTint;\n" + shader.fragmentShader.replace("#include <map_fragment>", "#include <map_fragment>\nfloat roofLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)); diffuseColor.rgb = mix(diffuseColor.rgb, roofLuma * vec3(0.48, 0.85, 0.8), ofbRoofTint);");
    };
    material.customProgramCacheKey = () => "ofb-roof-tint-v1";
    material.needsUpdate = true;
  });
}

type Surface = "stone" | "plaster" | "roof" | "wood";
const QUADRANTS: Record<Surface, [number, number]> = { stone: [0, 0], plaster: [1, 0], roof: [0, 1], wood: [1, 1] };
const METRES: Record<Surface, number> = { stone: 3, plaster: 2.5, roof: 2.4, wood: 1.4 };

// Object-space UVs are baked once. Camera movement never changes texture coordinates.
export function surfaceUVs(mesh: THREE.Mesh, surface: Surface) {
  const geometry = mesh.geometry, position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2), point = new THREE.Vector3(), n = new THREE.Vector3();
  mesh.updateMatrix();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrix);
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix);
    n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    const top = ay >= ax && ay >= az;
    const u = top || az >= ax ? point.x : point.z;
    const v = top ? point.z : point.y;
    uv[i * 2] = u / METRES[surface]; uv[i * 2 + 1] = v / METRES[surface];
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

export async function applyStreetMaterials(scene: THREE.Scene, signal: AbortSignal) {
  const image = new Image(); image.src = "/demos/ankh-morpork/material-atlas.png";
  await image.decode();
  if (signal.aborted) return 0;
  const textures = {} as Record<Surface, THREE.CanvasTexture>;
  const relief = {} as Record<Surface, THREE.CanvasTexture>;
  for (const [surface, [x, y]] of Object.entries(QUADRANTS) as [Surface, [number, number]][]) {
    const canvas = document.createElement("canvas"); canvas.width = Math.floor(image.width / 2); canvas.height = Math.floor(image.height / 2);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, x * image.width / 2, y * image.height / 2, image.width / 2, image.height / 2, 0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 8;
    textures[surface] = texture;
    // Luminance-derived relief is an appearance proxy, not a measured height scan.
    relief[surface] = texture.clone(); relief[surface].colorSpace = THREE.NoColorSpace;
  }
  let count = 0;
  const used = new Set<Surface>();
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.visible || !(object.material instanceof THREE.MeshStandardMaterial)) return;
    const surface = object.userData.surface as Surface;
    if (!textures[surface]) return;
    used.add(surface);
    surfaceUVs(object, surface);
    object.material.map?.dispose(); object.material.map = textures[surface];
    object.material.bumpMap = relief[surface]; object.material.bumpScale = surface === "stone" ? 0.035 : 0.012;
    object.material.color.set(surface === "stone" ? "#b5beb9" : "#ffffff");
    object.material.roughness = surface === "roof" ? 0.85 : 0.95; object.material.needsUpdate = true;
    count++;
  });
  for (const surface of Object.keys(textures) as Surface[]) if (!used.has(surface)) { textures[surface].dispose(); relief[surface].dispose(); }
  return count;
}
