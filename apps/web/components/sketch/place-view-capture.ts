import * as THREE from "three";
import { VIEW_PASSES, objectMaskColor, type ViewCapture, type ViewSource, type ViewPass } from "@/lib/place-view";

export function capturePlaceView(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
  sources: ViewSource[], mode: ViewCapture["mode"], floorId?: string, dimensions?: { width: number; height: number },
  onObjectPixels?: (rgba: Uint8ClampedArray, width: number, height: number) => void): ViewCapture {
  if (!(camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)) throw new Error("Unsupported camera");
  const size = renderer.getDrawingBufferSize(new THREE.Vector2()), scale = Math.min(1, 1024 / Math.max(size.x, size.y));
  // Providers round generated images down to multiples of 32; fresh captures
  // snap the same way so a generated result can match the saved view exactly.
  const snap = (n: number) => Math.max(32, Math.floor(n / 32) * 32);
  const width = dimensions?.width ?? snap(size.x * scale), height = dimensions?.height ?? snap(size.y * scale);
  if (![width, height].every(n => Number.isInteger(n) && n >= 32 && n <= 1024)) throw new Error("View dimensions must be between 32 and 1024 pixels");
  const capturedCamera = camera.clone(); capturedCamera.updateMatrixWorld(true);
  if (!dimensions && capturedCamera instanceof THREE.PerspectiveCamera) {
    capturedCamera.aspect = width / height; capturedCamera.updateProjectionMatrix();
  } else if (!dimensions && capturedCamera instanceof THREE.OrthographicCamera) {
    const center = (capturedCamera.left + capturedCamera.right) / 2, half = (capturedCamera.top - capturedCamera.bottom) / 2 * (width / height);
    capturedCamera.left = center - half; capturedCamera.right = center + half; capturedCamera.updateProjectionMatrix();
  }
  const objects = [...new Set(sources.flatMap(s => s.definition.objects.map(o => o.id)))].sort().map((object_id, i) => ({ object_id, rgb: objectMaskColor(i) }));
  const colors = new Map(objects.map(o => [o.object_id, o.rgb]));
  const hidden: THREE.Object3D[] = [], meshes: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  scene.traverse(object => {
    if ((object instanceof THREE.Line || object instanceof THREE.Sprite) && object.visible) { hidden.push(object); }
    if (object instanceof THREE.Mesh) meshes.push({ mesh: object, material: object.material });
  });
  // Glass stays in the color render; geometry passes see the opaque surface
  // behind it. Cutout textures need matched alpha tests, not solid silhouettes.
  for (const { mesh, material } of meshes) {
    let visible = true; for (let parent: THREE.Object3D | null = mesh; parent; parent = parent.parent) visible &&= parent.visible;
    if (visible && (mesh instanceof THREE.InstancedMesh || mesh instanceof THREE.SkinnedMesh || mesh.morphTargetInfluences?.some(v => v !== 0)
      || (Array.isArray(material) ? material : [material]).some(m => m.alphaTest > 0))) throw new Error("View capture does not yet support cutout, instanced, skinned or morphed geometry");
  }
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const { mesh } of meshes) {
    let visible = true; for (let parent: THREE.Object3D | null = mesh; parent; parent = parent.parent) visible &&= parent.visible;
    if (visible) bounds.union(new THREE.Box3().setFromObject(mesh, true));
  }
  const depths: number[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) depths.push(-new THREE.Vector3(x, y, z).applyMatrix4(capturedCamera.matrixWorldInverse).z);
  const near = Math.max(camera.near, Math.min(...depths)), far = Math.min(camera.far, Math.max(...depths));
  if (!Number.isFinite(near) || !Number.isFinite(far) || far <= near) throw new Error("No scene geometry is inside the camera depth range");
  const old = { target: renderer.getRenderTarget(), colorSpace: renderer.outputColorSpace, toneMapping: renderer.toneMapping, background: scene.background, override: scene.overrideMaterial, shadows: renderer.shadowMap.enabled };
  // WebGL allocates the attachment format on first use. Changing colorSpace
  // afterward does not remove its hardware sRGB conversion from data passes.
  const colorTarget = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
  colorTarget.texture.colorSpace = THREE.SRGBColorSpace;
  const dataTarget = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
  dataTarget.texture.colorSpace = THREE.NoColorSpace;
  const temporary: THREE.Material[] = [];
  const passes = {} as Record<ViewPass, string>;
  const depthMaterial = (side: THREE.Side) => new THREE.ShaderMaterial({ side, uniforms: { nearDepth: { value: near }, farDepth: { value: far } },
    vertexShader: "varying float viewDepth; void main(){vec4 p=modelViewMatrix*vec4(position,1.0);viewDepth=-p.z;gl_Position=projectionMatrix*p;}",
    fragmentShader: "uniform float nearDepth;uniform float farDepth;varying float viewDepth;void main(){float d=1.0-clamp((viewDepth-nearDepth)/(farDepth-nearDepth),0.0,1.0);gl_FragColor=vec4(vec3(d),1.0);}" });
  try {
    hidden.forEach(o => { o.visible = false; });
    for (const pass of VIEW_PASSES) {
      if (pass !== "render") {
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
        renderer.shadowMap.enabled = false; scene.background = new THREE.Color(0); scene.overrideMaterial = null;
        for (const item of meshes) {
          const replace = (original: THREE.Material) => {
            let material: THREE.Material;
            if (pass === "depth") material = depthMaterial(original.side);
            else if (pass === "normals") material = new THREE.MeshNormalMaterial({ side: original.side });
            else { const rgb = colors.get(item.mesh.userData.objectId) ?? [0, 0, 0]; material = new THREE.MeshBasicMaterial({ side: original.side, color: new THREE.Color().setRGB(rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255, THREE.LinearSRGBColorSpace), toneMapped: false }); }
            material.visible = original.visible && !original.transparent;
            temporary.push(material); return material;
          };
          item.mesh.material = Array.isArray(item.material) ? item.material.map(replace) : replace(item.material);
        }
      }
      const target = pass === "render" ? colorTarget : dataTarget;
      renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, capturedCamera);
      const pixels = new Uint8Array(width * height * 4); renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"); if (!context) throw new Error("Image capture is unavailable");
      const data = context.createImageData(width, height);
      for (let y = 0; y < height; y++) data.data.set(pixels.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4);
      if (pass === "objects") onObjectPixels?.(data.data, width, height);
      context.putImageData(data, 0, 0); passes[pass] = canvas.toDataURL("image/png");
    }
  } finally {
    for (const item of meshes) item.mesh.material = item.material;
    hidden.forEach(o => { o.visible = true; });
    scene.background = old.background; scene.overrideMaterial = old.override;
    renderer.outputColorSpace = old.colorSpace; renderer.toneMapping = old.toneMapping; renderer.shadowMap.enabled = old.shadows;
    renderer.setRenderTarget(old.target); colorTarget.dispose(); dataTarget.dispose(); temporary.forEach(m => m.dispose());
  }
  return { version: 1, mode, width, height, floor_id: floorId ?? null, sources,
    camera: { projection: camera instanceof THREE.PerspectiveCamera ? "perspective" : "orthographic", world_matrix: capturedCamera.matrixWorld.toArray(), projection_matrix: capturedCamera.projectionMatrix.toArray(), near: camera.near, far: camera.far },
    depth: { encoding: "linear_view_z_8bit_near_white", near, far }, normals: "view_space_rgb", surface_policy: "opaque_geometry", objects, passes };
}
