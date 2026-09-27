import * as THREE from "three";
import { WORLD, direction, type Pose, type RenderMode, type Vec3 } from "./contract";

const C = { plaster: "#ece8d9", wood: "#56433d", timber: "#302c32", roof: "#ae574e", stone: "#a9b5ad",
  paving: "#c6d0c3", water: "#368f9d", blue: "#507b90", green: "#698569", red: "#cb665b", brass: "#d9b36e" };

export function makeWorld() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#c5e4e9");
  scene.fog = new THREE.Fog("#c5e4e9", 38, 85);
  const materialCache = new Map<string, THREE.MeshLambertMaterial>();
  const resources = new Set<{ dispose(): void }>();
  const solids: THREE.Mesh[] = [];
  const outlines = new THREE.Group();
  scene.add(outlines);
  const ink = new THREE.LineBasicMaterial({ color: "#34363c", transparent: true, opacity: .38 });
  resources.add(ink);
  const material = (color: string) => {
    if (!materialCache.has(color)) { const m = new THREE.MeshLambertMaterial({ color }); materialCache.set(color, m); resources.add(m); }
    return materialCache.get(color)!;
  };
  function add(geometry: THREE.BufferGeometry, color: string, position: Vec3, solid = false, edge = false) {
    resources.add(geometry);
    const mesh = new THREE.Mesh(geometry, material(color));
    mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    if (solid) solids.push(mesh);
    if (edge) { const g = new THREE.EdgesGeometry(geometry); resources.add(g); const lines = new THREE.LineSegments(g, ink); mesh.add(lines); }
    return mesh;
  }
  function box(position: Vec3, size: Vec3, color: string, solid = false, edge = false) {
    return add(new THREE.BoxGeometry(...size), color, position, solid, edge);
  }
  function beam(a: Vec3, b: Vec3, width = .12, color = C.timber) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const mesh = box(start.clone().add(end).multiplyScalar(.5).toArray() as Vec3, [width, start.distanceTo(end), width], color);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    return mesh;
  }
  function barrel(x: number, z: number, height = .9) {
    add(new THREE.CylinderGeometry(.34, .3, height, 12), C.wood, [x, height / 2, z], true, true);
    for (const y of [.16, height - .16]) add(new THREE.CylinderGeometry(.346, .346, .06, 12), C.timber, [x, y, z]);
    add(new THREE.CylinderGeometry(.29, .29, .025, 12), "#9c8060", [x, height + .015, z]);
  }
  function jar(x: number, y: number, z: number, color: string, scale = 1) {
    add(new THREE.CylinderGeometry(.105 * scale, .14 * scale, .28 * scale, 10), color, [x, y + .14 * scale, z]);
    add(new THREE.CylinderGeometry(.08 * scale, .08 * scale, .07 * scale, 10), C.brass, [x, y + .31 * scale, z]);
  }
  // One continuous ground plane and one actual water edge. No image planes.
  box([15.0, -.55, -1], [35.5, 1, 85], C.stone);
  box([1.0, -.25, 3], [6.8, .5, 38], C.stone);
  box([-14, -.43, 2], [24, .12, 95], C.water);
  for (let z = -15; z < 22; z += 1.2) for (let x = -2.1; x < 3.3; x += .9) {
    const jitter = ((Math.round(z * 10) + Math.round(x * 10)) % 3) * .014;
    box([x, .005, z + (Math.round(x * 10) % 2 ? .3 : 0)], [.87, .025, 1.16], jitter > 0 ? "#c5cdbf" : C.paving);
  }
  for (let z = -14; z < 21; z += 1.2) box([-2.8, .2, z], [.42, .42, 1.18], "#bbc9c2", true, true);
  for (let z = -11; z < 18; z += 4.4) {
    add(new THREE.CylinderGeometry(.11, .15, 1.15, 10), C.timber, [-2.65, .58, z], true);
    add(new THREE.SphereGeometry(.14, 8, 6), C.brass, [-2.65, 1.17, z]);
  }
  // Static wave shapes make deterministic frames while supplying spatial scale.
  for (let i = 0; i < 75; i++) box([-3.5 - (i * 1.71) % 17, -.35, -16 + (i * 3.67) % 53], [.25 + (i % 4) * .16, .008, .035], "#7cc4cb");
  const { front: f, back: b, left: l, right: r, height: h } = WORLD.shop;
  const dl = WORLD.door.center - WORLD.door.width / 2, dr = WORLD.door.center + WORLD.door.width / 2;
  box([(f + b) / 2, -.08, (l + r) / 2], [b - f, .16, r - l], C.wood);
  for (let x = f; x < b; x += .32) box([x + .15, .015, (l + r) / 2], [.303, .025, r - l], Math.round(x * 100) % 3 ? "#967c66" : "#a58d71");
  box([b, h / 2, (l + r) / 2], [.24, h, r - l], C.plaster, true);
  box([(f + b) / 2, h / 2, l], [b - f, h, .24], C.plaster, true);
  box([(f + b) / 2, h / 2, r], [b - f, h, .24], C.plaster, true);
  box([f, h / 2, (l + dl) / 2], [.24, h, dl - l], C.plaster, true);
  box([f, 2.925, (dl + dr) / 2], [.24, .55, dr - dl], C.plaster, true);
  // The provisions opening is a real hole in the wall, right of the doorway.
  box([f, .48, (dr + r) / 2], [.24, .96, r - dr], C.wood, true);
  box([f, 2.87, (dr + r) / 2], [.24, .66, r - dr], C.plaster, true);
  box([f, 1.65, r - .16], [.24, 1.38, .32], C.plaster, true);
  box([(f + b) / 2, h + .1, (l + r) / 2], [b - f + .3, .2, r - l + .3], "#847564");
  for (const z of [l, dl, dr, r]) box([f - .1, h / 2, z], [.25, h, .18], C.timber, true);
  for (const y of [.15, 2.66, 3.2]) box([f - .14, y, (l + r) / 2], [.24, .18, r - l + .3], C.timber);
  for (const x of [5.4, 7.5, 9.6]) box([x, h - .07, (l + r) / 2], [.18, .22, r - l], C.timber);
  // Door is held open along the inside left wall; same hinge on both visits.
  box([4.13, 1.25, .15], [1.35, 2.5, .12], C.wood, true, true);
  for (const y of [.22, 1.25, 2.28]) box([4.13, y, .08], [1.28, .1, .05], C.timber);
  add(new THREE.TorusGeometry(.07, .017, 6, 12), C.brass, [4.58, 1.15, .06]);
  barrel(2.86, -.45); barrel(9.9, -1.75); barrel(10.3, 3.75);
  // Shop upper floor and low terracotta gable.
  box([(f + b) / 2, 4.3, (l + r) / 2], [b - f, 2.2, r - l], C.plaster);
  for (const z of [l, -.6, 1.6, r]) box([f - .06, 4.3, z], [.18, 2.3, .16], C.timber);
  box([f - .08, 5.4, (l + r) / 2], [.22, .18, r - l + .25], C.timber);
  for (const z of [-1.5, 3.0]) {
    box([f - .16, 4.4, z], [.05, 1.24, 1.05], C.timber, false, true);
    box([f - .2, 4.4, z], [.04, 1.06, .87], C.blue);
    box([f - .24, 4.4, z], [.06, 1.1, .075], C.timber);
    box([f - .24, 4.4, z], [.06, .065, .95], C.timber);
  }
  for (const x of [5.6, 9.1]) {
    box([x, 4.35, r + .04], [1.2, 1.28, .08], C.timber);
    box([x, 4.35, r + .1], [1.01, 1.08, .04], C.blue);
    box([x, 4.35, r + .14], [.07, 1.15, .05], C.timber);
    box([x, 4.35, r + .14], [1.1, .06, .05], C.timber);
  }
  for (const x of [f, 7.4, b]) box([x, 2.65, r + .06], [.18, 5.3, .18], C.timber);
  beam([f + .1, 3.3, r + .08], [7.3, 5.3, r + .08]);
  beam([7.5, 5.3, r + .08], [b - .1, 3.3, r + .08]);
  for (const side of [-1, 1]) {
    const roof = box([(f + b) / 2, 6.02, (l + r) / 2 + side * 2.03], [b - f + .75, .18, 4.57], C.roof, false, true);
    roof.rotation.x = side * .43;
  }
  beam([f - .22, 5.5, l - .35], [f - .22, 7, 1], .2);
  beam([f - .22, 7, 1], [f - .22, 5.5, r + .35], .2);
  // Recognizable display trays occupy the same physical window inside/outside.
  for (let i = 0; i < 3; i++) {
    box([3.38, 1.02, 2.15 + i * .73], [1.08, .14, .67], C.wood, true, true);
    for (let j = 0; j < 6; j++) add(new THREE.IcosahedronGeometry(.115, 1), [C.red, C.brass, C.green][i]!,
      [3.12 + (j % 2) * .3, 1.2, 1.94 + i * .73 + Math.floor(j / 2) * .18]);
    const sack = add(new THREE.SphereGeometry(.18, 10, 8), "#d6d1b9", [3.43, 2.18, 2.3 + i * .82]);
    sack.scale.set(.8, 1.4, 1);
    beam([3.43, 2.7, 2.3 + i * .82], [3.43, 2.3, 2.3 + i * .82], .027);
  }
  box([9.8, .52, 1], [.85, 1.04, 4.4], C.wood, true, true);
  box([9.8, 1.09, 1], [1.03, .14, 4.6], "#b39a75", false, true);
  jar(9.8, 1.16, 2.2, C.blue); jar(9.7, 1.16, -.25, C.green);
  for (const z of [-2.44, 4.43]) {
    for (const x of [5.6, 8.3]) {
      for (const y of [.3, 1.05, 1.8, 2.5]) {
        box([x, y, z], [2.35, .1, .49], C.wood, true);
        for (let j = 0; j < 5; j++) jar(x - .85 + j * .41, y + .05, z, [C.blue, C.green, C.plaster, C.red][j % 4]!, .8 + (j % 2) * .25);
      }
      for (const edge of [-1, 1]) box([x + edge * 1.15, 1.35, z], [.11, 2.7, .55], C.timber, true);
    }
  }
  box([11.23, 2, 1], [.12, .12, 3.1], C.wood);
  for (let i = 0; i < 6; i++) jar(11.02, 2.08, -.1 + i * .44, [C.blue, C.plaster, C.red][i % 3]!);
  // Neighboring facades, awnings, and moored boats supply real parallax.
  for (let i = 0; i < 5; i++) {
    const z = -6.0 - i * 5.5, color = ["#d5dbcf", "#dcc8bc", "#b5c6bd"][i % 3]!;
    box([6.3, 2.65, z], [5.4, 5.3, 4.9], color, true, true);
    for (const dz of [-2, 0, 2]) box([3.54, 2.65, z + dz], [.18, 5.3, .14], C.timber);
    for (const dy of [1.4, 3.8]) for (const dz of [-1.15, 1.15]) {
      box([3.5, dy, z + dz], [.12, 1.3, .9], C.timber);
      box([3.41, dy, z + dz], [.05, 1.08, .72], C.blue);
    }
    box([6.3, 5.5, z], [5.9, .4, 5.25], C.roof);
    const awning = box([2.75, 2.6, z], [1.55, .09, 3.25], i % 2 ? C.green : C.red);
    awning.rotation.z = -.15;
    for (const dz of [-1.5, 1.5]) box([2.05, 1.25, z + dz], [.07, 2.5, .07], C.timber, true);
    barrel(2.85, z - 2.2);
  }
  for (let i = 0; i < 3; i++) {
    const z = 3 - i * 8.5, x = -5.1 - i * 1.2;
    const hull = add(new THREE.SphereGeometry(1, 12, 6), C.wood, [x, -.03, z]); hull.scale.set(.72, .36, 2.1);
    beam([x, .1, z], [x, 4.1, z], .075);
    const sail = add(new THREE.ConeGeometry(1.3, 3.05, 3), "#a7d7e2", [x, 2.55, z]); sail.scale.set(.08, 1, 1); sail.rotation.x = .13;
    box([x, .19, z], [.8, .08, 2.75], "#90775f");
  }
  const hemisphere = new THREE.HemisphereLight("#d0ebf1", "#8c857d", 2.1); scene.add(hemisphere);
  const sun = new THREE.DirectionalLight("#fff2d8", 2.6);
  sun.position.set(-8, 16, -7); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 65 });
  sun.shadow.normalBias = .035; sun.shadow.bias = -.00015; scene.add(sun); resources.add(sun.shadow);
  const interiorLight = new THREE.PointLight("#ffe9c2", 24, 13, 2); interiorLight.position.set(7.5, 2.7, 1); scene.add(interiorLight);
  const clay = new THREE.MeshLambertMaterial({ color: "#c4c9cc" }); resources.add(clay);
  scene.updateMatrixWorld(true);
  const bounds = solids.map(mesh => {
    const bound = new THREE.Box3().setFromObject(mesh).expandByScalar(.18);
    // Floor-standing props block the body, not just the camera's eye point.
    // Leave overhead lintels elevated so their doorway remains traversable.
    if (bound.min.y < .7) bound.max.y = Math.max(bound.max.y, WORLD.camera.height + .2);
    return bound;
  });
  const raycaster = new THREE.Raycaster();
  function canOccupy(position: Vec3) {
    const p = new THREE.Vector3(...position);
    if (p.x < -2.3 || p.x > 11.1 || p.z < -14 || p.z > 12) return false;
    if (p.x > 3.2 && (p.z < -2.45 || p.z > 4.45)) return false;
    return !bounds.some(bound => bound.containsPoint(p));
  }
  function canMove(from: Vec3, to: Vec3) {
    if (!canOccupy(to)) return false;
    const delta = new THREE.Vector3(...to).sub(new THREE.Vector3(...from));
    if (delta.length() === 0) return true;
    raycaster.set(new THREE.Vector3(...from), delta.clone().normalize()); raycaster.far = delta.length() + .18;
    return !bounds.some(bound => {
      const hit = raycaster.ray.intersectBox(bound, new THREE.Vector3());
      return hit && hit.distanceTo(raycaster.ray.origin) <= raycaster.far;
    });
  }
  return { scene, solids, canOccupy, canMove,
    setMode(mode: RenderMode) { scene.overrideMaterial = mode === "clay" ? clay : null; },
    dispose() { for (const resource of resources) resource.dispose(); scene.clear(); } };
}

export function applyPose(camera: THREE.PerspectiveCamera, pose: Pose) {
  camera.position.set(...pose.position);
  const d = direction(pose);
  camera.lookAt(pose.position[0] + d[0], pose.position[1] + d[1], pose.position[2] + d[2]);
  camera.updateMatrixWorld(true);
}
