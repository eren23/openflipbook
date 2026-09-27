import type { PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { blankSketch, parseSketch, type SketchElement, type SketchState } from "./sketch-types";
import { resolveSceneObject } from "./floor-placement";
import { footprintPoints } from "./building-footprint";

import type { MapRegistration } from "./map-artwork-binding";
export type { MapRegistration, MapRepaintBinding } from "./map-artwork-binding";
export function parseMapRegistration(value: unknown): MapRegistration {
  const r = value as MapRegistration;
  if (!r || ![r.x, r.y, r.width, r.rotation].every(Number.isFinite) || r.x < 0 || r.x > 100 || r.y < 0 || r.y > 100 || r.width < 1 || r.width > 80 || Math.abs(r.rotation) > 180) throw new Error("Invalid map placement");
  return { x: r.x, y: r.y, width: r.width, rotation: r.rotation };
}
export function mapObject(o: PlaceSceneObject, scene: PlaceSceneDefinition, r: MapRegistration, frame: { width: number; height: number }) {
  o = resolveSceneObject(scene, o);
  const scale = r.width / 100 * frame.width / scene.width, angle = r.rotation * Math.PI / 180;
  const dx = (o.x - scene.width / 2) * scale, dy = (o.z - scene.depth / 2) * scale;
  const cx = r.x / 100 * frame.width + dx * Math.cos(angle) - dy * Math.sin(angle);
  const cy = r.y / 100 * frame.height + dx * Math.sin(angle) + dy * Math.cos(angle);
  const width = o.width * scale, height = o.depth * scale, rotation = angle + o.heading;
  const points = footprintPoints(o).map(p => ({ x: cx + p.x * scale * Math.cos(rotation) - p.z * scale * Math.sin(rotation), y: cy + p.x * scale * Math.sin(rotation) + p.z * scale * Math.cos(rotation) }));
  return { cx, cy, width, height, rotation, points };
}
export function mapChanges(before: PlaceSceneDefinition, after: PlaceSceneDefinition) {
  const stable = (o: PlaceSceneObject | undefined) => {
    if (!o) return "";
    const { stair: _stair, ...shell } = o.structure ?? {};
    const exterior = o.structure ? { ...o, structure: { ...shell, floors: o.structure.floors.map(f => ({ id: f.id })) } } : o;
    return JSON.stringify(Object.entries(exterior).sort(([a], [b]) => a.localeCompare(b)));
  };
  return [...new Set([...before.objects.map(o => o.id), ...after.objects.map(o => o.id)])].flatMap(id => {
    const old = before.objects.find(o => o.id === id && !o.placement), next = after.objects.find(o => o.id === id && !o.placement);
    return stable(old) === stable(next) ? [] : [{ before: old, after: next }];
  });
}
export function mapReviewBounds(state: SketchState) {
  const masks = state.scene.elements.filter(e => !e.isDeleted && e.customData?.role === "mask");
  if (!masks.length) return null;
  const left = Math.min(...masks.map(e => e.x)), top = Math.min(...masks.map(e => e.y));
  const right = Math.max(...masks.map(e => e.x + e.width)), bottom = Math.max(...masks.map(e => e.y + e.height));
  const padding = Math.max(32, Math.max(right - left, bottom - top) * 0.75);
  const x = Math.max(0, left - padding), y = Math.max(0, top - padding);
  return { x, y, width: Math.min(state.frame.width, right + padding) - x, height: Math.min(state.frame.height, bottom + padding) - y };
}
export function mapRepaintState(before: PlaceSceneDefinition, after: PlaceSceneDefinition, registration: MapRegistration, frame: { width: number; height: number }, revision: number): SketchState {
  const r = parseMapRegistration(registration), changes = mapChanges(before, after);
  if (!changes.length) throw new Error("No object changes since the last map baseline");
  if (changes.length > 20) throw new Error("Repaint at most 20 changed objects at a time");
  // Place resizing changes the coordinate frame; it needs a separately reviewed baseline registration.
  if (before.width !== after.width || before.depth !== after.depth) throw new Error("Map repaint requires unchanged place dimensions");
  const elements: SketchElement[] = [], instructions: string[] = ["CRITICAL FINISH: Remove every blue/cyan rectangular guide stroke and red dashed stroke completely. Replace guide pixels with natural warm-sepia ink outlines and matching parchment, never colored borders or roof trim. Render requested roof colors as muted antique washes, not saturated guide colors."];
  const element = (id: string, x: number, y: number, width: number, height: number, angle: number, role: string): SketchElement => ({ id, type: "rectangle", x, y, width, height, angle, strokeColor: role === "mask" ? "#148aa8" : role === "remove" ? "#ad3845" : "#167cb0", backgroundColor: "transparent", fillStyle: "solid", strokeStyle: role === "remove" ? "dashed" : "solid", strokeWidth: 2, roughness: 0, opacity: role === "mask" ? 25 : 100, seed: 1, version: 1, versionNonce: 1, isDeleted: false, groupIds: [], frameId: null, boundElements: [], updated: 1, link: null, locked: false, roundness: null, customData: { role } });
  changes.forEach((change, index) => {
    const old = change.before ? mapObject(change.before, before, r, frame) : null;
    const next = change.after ? mapObject(change.after, after, r, frame) : null;
    const points = [...(old?.points ?? []), ...(next?.points ?? [])];
    if (points.some(p => p.x < 2 || p.y < 2 || p.x > frame.width - 2 || p.y > frame.height - 2)) throw new Error("Changed footprints must fit fully inside the map");
    const padding = 6, left = Math.max(0, Math.floor(Math.min(...points.map(p => p.x)) - padding)), top = Math.max(0, Math.floor(Math.min(...points.map(p => p.y)) - padding));
    const right = Math.min(frame.width, Math.ceil(Math.max(...points.map(p => p.x)) + padding)), bottom = Math.min(frame.height, Math.ceil(Math.max(...points.map(p => p.y)) + padding));
    elements.push({ ...element(`map-mask-${index}`, left, top, right - left, bottom - top, 0, "mask"), backgroundColor: "#148aa8" });
    for (const [footprint, role, object] of [[old, "remove", change.before], [next, "footprint", change.after]] as const) if (footprint) {
      if (object?.structure?.footprint) {
        const x = Math.min(...footprint.points.map(p => p.x)), y = Math.min(...footprint.points.map(p => p.y));
        const width = Math.max(...footprint.points.map(p => p.x)) - x, height = Math.max(...footprint.points.map(p => p.y)) - y;
        const origin = footprint.points[0]!;
        elements.push({ ...element(`map-${role}-${index}`, origin.x, origin.y, width, height, 0, role), type: "line", points: [...footprint.points, origin].map(p => [p.x - origin.x, p.y - origin.y]), startArrowhead: null, endArrowhead: null });
      } else elements.push(element(`map-${role}-${index}`, footprint.cx - footprint.width / 2, footprint.cy - footprint.height / 2, footprint.width, footprint.height, footprint.rotation, role));
    }
    for (const e of elements) e.frameId = "ofb-frame";
    const o = change.after ?? change.before!, p = next ?? old!;
    instructions.push(`${change.after ? change.before ? "UPDATE" : "ADD" : "REMOVE"} ${JSON.stringify(o.label)} (${o.kind}): centre (${(100 * p.cx / frame.width).toFixed(2)}%, ${(100 * p.cy / frame.height).toFixed(2)}%), plan footprint ${p.width.toFixed(1)} x ${p.height.toFixed(1)} pixels, rotation ${(p.rotation * 180 / Math.PI).toFixed(1)} degrees clockwise. Authored size ${o.width.toFixed(2)} x ${o.depth.toFixed(2)} m, height ${o.height.toFixed(2)} m${o.roof_material ? `, ${o.roof_material} roof` : ""}.`);
  });
  return parseSketch({ ...blankSketch(), title: `Map artwork / ${after.label} / r${revision}`.slice(0, 160), model: "nano", scope: "region", workflow: "render", output: "artwork", viewpoint: "overhead", frame, scene: { elements, files: {} }, prompt: `Update this antique cartographer's map to the reviewed saved-world changes below. Keep the source's exact parchment, palette, hand-inked linework, lettering, top-down map convention and detail density. Blue solid outlines are the desired footprints; red dashed outlines show prior footprints to replace or remove. They are instructions: erase all colored annotations from the result. Preserve every unlisted landmark, existing label, street, river and surrounding building. Add each requested object exactly once, at the indicated position and scale, as a map symbol matching neighboring roofs, never a street-view inset or a 3D render. Keep existing place names legible; do not add a large new label. Blend changed roofs and ground into the original chart. Do not relocate surrounding streets to fit the edit. These are manually registered local changes, not a whole-map redesign.\n${instructions.join("\n")}` });
}
