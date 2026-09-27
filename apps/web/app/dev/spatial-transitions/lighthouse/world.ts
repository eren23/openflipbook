import * as THREE from "three";
import contract from "./scene.json";

export { contract };
export type Mode = "color" | "clay" | "depth";

export function makeLighthouse() {
  const scene = new THREE.Scene();
  const resources: { dispose(): void }[] = [];
  const meshes: THREE.Mesh[] = [];
  const materials: THREE.Material[] = [];
  function add(geometry: THREE.BufferGeometry, color: string, position: number[]) {
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0]!, position[1]!, position[2]!);
    scene.add(mesh); meshes.push(mesh); materials.push(material); resources.push(geometry, material);
    return mesh;
  }
  const tower = contract.tower;
  add(new THREE.CylinderGeometry(tower.topRadius, tower.baseRadius, tower.height, 12), "#adada3", [0, 5, 0]);
  add(new THREE.CylinderGeometry(2.12, 2.12, .8, 12), "#8d9594", [0, .4, 0]);
  add(new THREE.CylinderGeometry(1.5, 1.4, .45, 16), "#989c96", [0, 9.95, 0]);
  // Open bowl rim and two visible arms; no invented ring of extra supports.
  const rim = add(new THREE.TorusGeometry(1.35, .17, 8, 24), "#a9b0a9", [0, 10.3, 0]);
  rim.rotation.x = Math.PI / 2;
  for (const side of [-1, 1]) {
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 1.25, 10.2, 0), new THREE.Vector3(side * 1.55, 10.9, 0),
      new THREE.Vector3(side * 1.6, 11.65, 0), new THREE.Vector3(side * 1.45, 12.1, 0),
    ]);
    add(new THREE.TubeGeometry(path, 12, .18, 6, false), "#b4bab0", [0, 0, 0]);
  }
  const crystal = add(new THREE.OctahedronGeometry(1.05), "#63d6ed", [0, 13, 0]);
  crystal.scale.set(.85, 1.75, .8);
  for (const [x, y, z] of [[-1.55, 13.15, .2], [1.2, 13.8, -.1], [.9, 12.4, .2]]) {
    const shard = add(new THREE.OctahedronGeometry(.2), "#b0eeed", [x!, y!, z!]); shard.scale.y = 1.7;
  }
  const annex = contract.annex;
  add(new THREE.BoxGeometry(...annex.size as [number, number, number]), "#b5b3a5", annex.position);
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-annex.size[0]! / 2 - .15, 0);
  roofShape.lineTo(0, annex.roofHeight);
  roofShape.lineTo(annex.size[0]! / 2 + .15, 0); roofShape.closePath();
  add(new THREE.ExtrudeGeometry(roofShape, { depth: annex.size[2]! + .3, bevelEnabled: false }), "#b66049",
    [annex.position[0]!, annex.size[1]!, annex.position[2]! - annex.size[2]! / 2 - .15]);
  // Openings only on visible faces. Rear elevations are left unspecified.
  for (const y of [1.3, 5.3, 8]) add(new THREE.BoxGeometry(.34, .8, .035), "#416872", [0, y, 2.08 - y * .075]);
  for (const x of [2, 3.4]) add(new THREE.BoxGeometry(.45, .65, .035), "#416872", [x, 1.8, annex.position[2]! + annex.size[2]! / 2 + .02]);
  const ground = add(new THREE.PlaneGeometry(100, 100), "#8b9c85", [0, 0, 0]); ground.rotation.x = -Math.PI / 2;
  scene.add(new THREE.HemisphereLight("#effbff", "#64747d", 2.2));
  const sun = new THREE.DirectionalLight("#ffffff", 2.1); sun.position.set(-8, 20, 12); scene.add(sun);
  const clay = new THREE.MeshLambertMaterial({ color: "#b7bdc1" });
  const depth = new THREE.ShaderMaterial({
    vertexShader: "varying float z; void main(){vec4 p=modelViewMatrix*vec4(position,1.0);z=-p.z;gl_Position=projectionMatrix*p;}",
    fragmentShader: "varying float z; void main(){float d=clamp(1.0-z/60.0,0.0,1.0);gl_FragColor=vec4(vec3(d),1.0);}",
  });
  resources.push(clay, depth);
  function setMode(mode: Mode) {
    scene.background = new THREE.Color(mode === "depth" ? "#000000" : mode === "clay" ? "#e3e7eb" : "#99cddd");
    meshes.forEach((mesh, i) => { mesh.material = mode === "color" ? materials[i]! : mode === "clay" ? clay : depth; });
  }
  setMode("color");
  return { scene, setMode, dispose: () => resources.forEach(r => r.dispose()) };
}

export function placeCamera(camera: THREE.PerspectiveCamera, lateral = 0) {
  const { position, target } = contract.camera;
  camera.position.set(position[0]! + lateral, position[1]!, position[2]!);
  camera.lookAt(...target as [number, number, number]); camera.updateMatrixWorld(true);
}
