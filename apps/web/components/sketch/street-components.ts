import * as THREE from "three";
import type { PlaceSceneObject } from "@openflipbook/config";

type Box = (x: number, y: number, z: number, w: number, h: number, d: number, color?: string, solid?: boolean) => THREE.Mesh;

// Front is local -Z. Building height includes the roof; doors are closed exteriors.
export function buildStreetComponent(o: PlaceSceneObject, group: THREE.Group, box: Box, eaveHeight?: number): boolean {
  const b: Box = (...args) => {
    const mesh = box(...args), color = args[6];
    mesh.userData.surface = color === "#49453c" || color === "#697665" ? "wood" : color === "#c3c5ae" || color === "#afb7af" ? "plaster" : ["#7e8986", "#adb5a8", "#7c8580", "#bcc2b4"].includes(color || "") ? "stone" : null;
    return mesh;
  };
  if (o.kind === "tavern" || o.kind === "house") {
    const tavern = o.kind === "tavern", eaves = eaveHeight ?? o.eave_height ?? o.height * 11 / 14, w = o.width, d = o.depth, ridgeX = o.roof_offset ?? 0;
    const timber = "#49453c", plaster = tavern ? "#c3c5ae" : "#afb7af";
    b(0, eaves / 2, 0, w, eaves, d, plaster);
    b(0, 0.45, 0, w + 0.02, 0.9, d + 0.02, "#7e8986", false);
    const shape = new THREE.Shape(); shape.moveTo(-w / 2, eaves); shape.lineTo(ridgeX, o.height); shape.lineTo(w / 2, eaves); shape.closePath();
    const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false }), new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.95 }));
    roof.position.z = -d / 2; roof.castShadow = true; roof.receiveShadow = true; roof.userData.objectId = o.id; roof.userData.surface = "wood"; group.add(roof);
    const rise = o.height - eaves;
    for (const side of [-1, 1]) {
      const run = w / 2 - side * ridgeX, slope = Math.atan2(rise, run), length = Math.hypot(run, rise);
      for (let row = 0; row < 12; row++) {
        const t = (row + 0.5) / 12;
        const tile = b(ridgeX + (side * w / 2 - ridgeX) * t, o.height - rise * t + 0.02, 0, length / 12 - 0.012, 0.035, d, o.color, false);
        tile.userData.surface = "roof";
        (tile.material as THREE.MeshStandardMaterial).color.multiplyScalar(row % 3 === 0 ? 0.9 : 1);
        tile.rotation.z = -side * slope;
      }
      for (const z of [-d / 2 - 0.025, d / 2 + 0.025]) {
        const bar = b((ridgeX + side * w / 2) / 2, eaves + rise / 2, z, length, 0.11, 0.08, timber, false); bar.rotation.z = -side * slope;
      }
    }
    for (const z of [-d / 2 - 0.025, d / 2 + 0.025]) {
      for (const x of [-w / 2 + 0.12, -w / 4, 0, w / 4, w / 2 - 0.12]) b(x, eaves / 2, z, 0.13, eaves, 0.09, timber, false);
      for (const y of [1, eaves * 0.5, eaves - 0.12]) b(0, y, z, w, 0.13, 0.09, timber, false);
      for (const x of [-w * 0.29, 0, w * 0.29]) {
        b(x, eaves * 0.74, z * 1.005, w * 0.135, eaves * 0.2, 0.12, timber, false);
        b(x, eaves * 0.74, z * 1.012, w * 0.11, eaves * 0.165, 0.13, "#d9b775", false);
        b(x, eaves * 0.74, z * 1.025, 0.05, eaves * 0.17, 0.14, timber, false);
        b(x, eaves * 0.74, z * 1.025, w * 0.11, 0.05, 0.14, timber, false);
      }
    }
    const doorX = -w * 0.04, doorW = w * 0.16, doorH = eaves * 0.42;
    for (const side of [-1, 1]) {
      for (const z of [-d * 0.4, 0, d * 0.4]) b(side * w / 2, eaves / 2, z, 0.1, eaves, 0.13, timber, false);
      for (const y of [1, eaves * 0.5, eaves - 0.12]) b(side * w / 2, y, 0, 0.1, 0.13, d, timber, false);
    }
    b(doorX, doorH / 2, -d / 2 - 0.065, doorW + 0.22, doorH + 0.18, 0.13, timber, false);
    for (let i = 0; i < 6; i++) b(doorX - doorW / 2 + (i + 0.5) * doorW / 6, doorH / 2, -d / 2 - 0.14, doorW / 6 - 0.012, doorH, 0.045, "#697665", false);
    for (const y of [doorH * 0.25, doorH * 0.75]) b(doorX, y, -d / 2 - 0.17, doorW * 0.9, 0.065, 0.05, timber, false);
    b(doorX + doorW * 0.3, doorH * 0.5, -d / 2 - 0.21, 0.08, 0.13, 0.06, "#b09b65", false);
    for (const side of [-1, 1]) for (const y of [0.2, 0.55, 0.9]) b(side * (w / 2 - 0.2), y, -d / 2 - 0.055, 0.4, 0.25, 0.09, "#adb5a8", false);
    b(-w * 0.38, o.height * 0.85, d * 0.34, w * 0.07, o.height * 0.28, d * 0.14, "#7c8580", false);
    if (tavern) {
      // One frontage sign: readable mesh tankard, with text when canvas is available.
      b(w * 0.4, eaves * 0.67, -d / 2 - 0.42, 0.1, 0.1, 0.85, timber, false);
      const sign = b(w * 0.4, eaves * 0.55, -d / 2 - 0.8, 1, 0.8, 0.08, "#385c55", false);
      const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        canvas.width = 512; canvas.height = 384; ctx.fillStyle = "#385c55"; ctx.fillRect(0, 0, 512, 384);
        ctx.strokeStyle = "#c9be8c"; ctx.lineWidth = 10; ctx.strokeRect(14, 14, 484, 356);
        ctx.fillStyle = "#e5ddbe"; ctx.textAlign = "center"; ctx.font = "bold 48px Georgia"; ctx.fillText("THE MENDED", 256, 83); ctx.fillText("DRUM", 256, 140);
        ctx.fillRect(208, 185, 90, 120); ctx.lineWidth = 16; ctx.strokeRect(296, 205, 40, 70);
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
        (sign.material as THREE.MeshStandardMaterial).map = texture; (sign.material as THREE.MeshStandardMaterial).color.set("white");
      }
    }
    return true;
  }
  if (o.kind === "well" || o.kind === "barrels") {
    const cylinder = (x: number, radius: number, height: number, color: string, y = height / 2) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
      mesh.position.set(x, y, 0); mesh.scale.z = o.depth / o.width; mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.objectId = o.id; mesh.userData.surface = color === o.color ? o.kind === "well" ? "stone" : "wood" : null; group.add(mesh);
    };
    // Conservative footprint keeps the player out of water and stacked barrels.
    const collider = b(0, o.height / 2, 0, o.width, o.height, o.depth, o.color); collider.visible = false;
    if (o.kind === "well") {
      cylinder(0, o.width / 2, o.height, o.color);
      cylinder(0, o.width * 0.38, 0.015, "#304a4a", o.height + 0.01);
      for (let i = 0; i < 12; i++) {
        const angle = i / 12 * Math.PI * 2;
        const stone = b(Math.cos(angle) * o.width * 0.44, o.height + 0.04, Math.sin(angle) * o.depth * 0.44, o.width * 0.22, 0.13, o.depth * 0.13, "#bcc2b4", false); stone.rotation.y = -angle - Math.PI / 2;
      }
    } else {
      for (const x of [-o.width * 0.25, o.width * 0.25]) {
        cylinder(x, o.width * 0.24, o.height, o.color);
        for (const y of [0.15, 0.75]) cylinder(x, o.width * 0.247, o.height * 0.08, "#525d58", o.height * y);
      }
    }
    return true;
  }
  return false;
}
