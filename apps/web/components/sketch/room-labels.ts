import * as THREE from "three";
import type { PlaceSceneObject } from "@openflipbook/config";
import { roomLayoutGeometry } from "@/lib/room-layout";
import { storeyHeight } from "@/lib/building-structure";

export function addRoomLabels(group: THREE.Group, object: PlaceSceneObject, floor: number) {
  for (const room of roomLayoutGeometry(object, floor).rooms) {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 80;
    const context = canvas.getContext("2d"); if (!context) continue;
    context.font = "48px Arial"; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillStyle = "#ffffffdf"; context.fillRect(0, 0, 512, 80);
    context.fillStyle = "#24302f";
    context.fillText(room.label, 256, 40, 492);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    const area = room.cells?.reduce((best, r) => (r.x2 - r.x1) * (r.z2 - r.z1) > (best.x2 - best.x1) * (best.z2 - best.z1) ? r : best) ?? room;
    label.position.set((area.x1 + area.x2) / 2, floor * storeyHeight(object) + 0.05, (area.z1 + area.z2) / 2);
    const width = Math.min(3.5, area.x2 - area.x1 - 0.2, area.z2 - area.z1 - 0.2); label.scale.set(width, width * 80 / 512, 1);
    label.userData.objectId = object.id; label.userData.roomId = room.id; label.renderOrder = 5; group.add(label);
  }
}
