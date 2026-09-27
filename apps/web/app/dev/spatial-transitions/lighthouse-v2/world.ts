import * as THREE from "three";
import { WORLD, type Mode } from "./contract";

export function makeWorld() {
  const scene = new THREE.Scene();
  const resources = new Set<{ dispose(): void }>();
  const meshes: THREE.Mesh[] = [], materials: THREE.Material[] = [], lines: THREE.LineSegments[] = [];
  const ink = new THREE.LineBasicMaterial({ color: "#344047" }); resources.add(ink);
  function stroke(points: THREE.Vector3[], color = ink) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points); resources.add(geometry);
    const line = new THREE.LineSegments(geometry, color); scene.add(line); lines.push(line); return line;
  }
  function add(name: string, geometry: THREE.BufferGeometry, color: string, position: number[], outline = true) {
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.position.fromArray(position);
    scene.add(mesh); meshes.push(mesh); materials.push(material); resources.add(geometry); resources.add(material);
    if (outline) {
      const edges = new THREE.EdgesGeometry(geometry, 22); resources.add(edges);
      const line = new THREE.LineSegments(edges, ink); mesh.add(line); lines.push(line);
    }
    return mesh;
  }
  function cylinder(name: string, top: number, bottom: number, height: number, y: number, color: string) {
    const mesh = add(name, new THREE.CylinderGeometry(top, bottom, height, y > 9.7 ? 16 : WORLD.tower.sides), color, [0, y, 0]);
    mesh.rotation.y = Math.PI / 8; return mesh;
  }
  const t = WORLD.tower;
  cylinder("base-lower", t.lowerRadius, t.lowerRadius, t.lowerHeight, t.lowerHeight / 2, "#acb4b7");
  cylinder("base-upper", t.upperRadius, t.upperRadius, t.upperHeight, t.lowerHeight + t.upperHeight / 2, "#b8bec0");
  cylinder("shaft", t.shaftTopRadius, 2.05, t.shaftHeight, 3.45 + t.shaftHeight / 2, "#b9c1c3");
  for (const [y, radius] of [[.15, 2.65], [1.9, 2.65], [2.05, 2.28], [3.45, 2.3]]) cylinder("base-band", radius!, radius!, .17, y!, "#8e9ca3");
  cylinder("crown-neck", 1.6, 1.3, .45, 9.85, "#a7b3b8");
  // Closed annular wall with an exposed basin; no opaque cap across the opening.
  const bowl = new THREE.LatheGeometry([new THREE.Vector2(1.35, 10), new THREE.Vector2(1.65, 10.5),
    new THREE.Vector2(1.65, 10.7), new THREE.Vector2(1.43, 10.7), new THREE.Vector2(1.22, 10.08), new THREE.Vector2(1.35, 10)], 24);
  add("open-crown", bowl, "#b4c7cf", [0, 0, 0]);
  cylinder("basin", 1.24, 1.24, .04, 10.08, "#6bafb7");
  for (const side of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(side * 1.3, 10.3); shape.quadraticCurveTo(side * 2.15, 10.8, side * 2.1, 12.15);
    shape.lineTo(side * 1.7, 12.45); shape.quadraticCurveTo(side * 1.9, 11.15, side * .95, 10.6); shape.closePath();
    add(`crown-arm-${side}`, new THREE.ExtrudeGeometry(shape, { depth: .55, bevelEnabled: false }), "#9faeb8", [0, 0, -.275]);
  }
  const crystal = add("crystal", new THREE.OctahedronGeometry(1), "#77e3e7", [0, 13.2, 0]);
  crystal.scale.set(.85, 1.7, .85);
  for (const [i, p] of [[-1.45, 13.6, .1], [1.2, 14.2, -.1], [1.1, 12.9, .3]].entries()) {
    const shard = add(`shard-${i}`, new THREE.OctahedronGeometry(.23), i === 0 ? "#b6b3e4" : "#93eced", p); shard.scale.y = 1.8;
  }
  function arch(x: number, bottom: number, radius: number, spring: number) {
    const shape = new THREE.Shape(); shape.moveTo(x - radius, bottom); shape.lineTo(x + radius, bottom);
    shape.lineTo(x + radius, spring); shape.absarc(x, spring, radius, 0, Math.PI, false); shape.closePath(); return shape;
  }
  // Source-visible front recesses only. Back walls do not get invented windows.
  for (const [x, y, radius, spring, z] of [[0, .16, .42, 1.12, 2.56], [-1.25, 2.23, .28, 2.9, 1.89],
    [0, 2.23, .28, 2.9, 2.21], [.1, 4.3, .2, 5.1, 1.82], [.1, 7.1, .17, 7.75, 1.5]]) {
    add("front-recess", new THREE.ShapeGeometry(arch(x!, y!, radius!, spring!)), "#355563", [0, 0, z!]);
  }
  const a = WORLD.annex;
  add("annex-rear", new THREE.BoxGeometry(a.end - a.start, a.eave, .22), "#758892", [(a.start + a.end) / 2, a.eave / 2, -1.29]);
  add("annex-end", new THREE.BoxGeometry(.22, a.eave, a.depth), "#a6b5ba", [a.end, a.eave / 2, 0]);
  const facade = new THREE.Shape(); facade.moveTo(a.start, 0); facade.lineTo(a.end, 0); facade.lineTo(a.end, a.eave); facade.lineTo(a.start, a.eave); facade.closePath();
  for (const x of a.bays) facade.holes.push(new THREE.Path(arch(x, .15, .73, 1.78).getPoints(24)));
  add("arcade", new THREE.ExtrudeGeometry(facade, { depth: .22, bevelEnabled: false }), "#c1cace", [0, 0, 1.18]);
  add("arcade-floor", new THREE.BoxGeometry(a.end - a.start, .12, a.depth), "#879998", [(a.start + a.end) / 2, .06, 0]);
  const roof = new THREE.Shape(); roof.moveTo(-1.6, 0); roof.lineTo(0, a.roofHeight); roof.lineTo(1.6, 0); roof.closePath();
  const roofMesh = add("annex-roof", new THREE.ExtrudeGeometry(roof, { depth: a.end - a.start + .3, bevelEnabled: false }), "#b75b4b", [a.start - .15, a.eave, 0]);
  roofMesh.rotation.y = Math.PI / 2;
  const roofLines: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    for (let z = .2; z < 1.6; z += .22) roofLines.push(new THREE.Vector3(a.start - .15, a.eave + a.roofHeight * (1 - z / 1.6) + .015, z * side), new THREE.Vector3(a.end + .15, a.eave + a.roofHeight * (1 - z / 1.6) + .015, z * side));
    for (let x = a.start; x < a.end; x += .36) roofLines.push(new THREE.Vector3(x, a.eave + a.roofHeight + .015, 0), new THREE.Vector3(x, a.eave + .015, 1.6 * side));
  }
  stroke(roofLines);
  const masonry: THREE.Vector3[] = [];
  for (let y = 3.8; y < 9.6; y += .62) {
    const radius = 2.05 + (t.shaftTopRadius - 2.05) * ((y - 3.45) / t.shaftHeight) + .008;
    for (let i = 0; i < 8; i++) {
      const p = i * Math.PI / 4 + Math.PI / 8, q = p + Math.PI / 4;
      masonry.push(new THREE.Vector3(Math.sin(p) * radius, y, Math.cos(p) * radius), new THREE.Vector3(Math.sin(q) * radius, y, Math.cos(q) * radius));
    }
  }
  stroke(masonry);
  const ground = add("assumed-ground", new THREE.PlaneGeometry(80, 80), "#849b92", [0, -.02, 0], false); ground.rotation.x = -Math.PI / 2;
  scene.add(new THREE.HemisphereLight("#f0f6ff", "#71818d", 2.1));
  const light = new THREE.DirectionalLight("#fff5e9", 2.2); light.position.set(-8, 18, 15); scene.add(light);
  const clay = new THREE.MeshLambertMaterial({ color: "#b7c1c8" }); resources.add(clay);
  const depth = new THREE.ShaderMaterial({ vertexShader: "varying float z; void main(){vec4 p=modelViewMatrix*vec4(position,1.0);z=-p.z;gl_Position=projectionMatrix*p;}", fragmentShader: "varying float z; void main(){float d=clamp(1.0-z/60.0,0.0,1.0);gl_FragColor=vec4(vec3(d),1.0);}" }); resources.add(depth);
  function setMode(mode: Mode) {
    scene.background = new THREE.Color(mode === "depth" ? "#000000" : mode === "clay" ? "#e5e9eb" : "#b7d6e0");
    meshes.forEach((mesh, i) => { mesh.material = mode === "color" ? materials[i]! : mode === "clay" ? clay : depth; });
    lines.forEach(line => { line.visible = mode !== "depth"; });
  }
  setMode("color");
  return { scene, setMode, dispose: () => resources.forEach(resource => resource.dispose()) };
}
