import type { PlaceSceneDefinition } from "@openflipbook/config";
import { parseAlignmentFrame, parseMapLandmarks, type MapAlignmentDraft } from "./map-alignment";
import { parseMapRegistration } from "./map-artwork";
import { parsePlaceScene } from "./place-scene";
import { validateOutdoorBuild } from "./place-build";

export interface MapAlignmentCorrection {
  projection: "manual_planar";
  draft: MapAlignmentDraft;
  map_root_node_id: string;
  object_ids: string[];
}

// An explicit edit under an assumed projection, not an image reconstruction.
// Only translate selected top-level objects; floor-local contents move with them.
export function correctMapLandmarks(definition: PlaceSceneDefinition, draft: MapAlignmentDraft, rawIds: unknown) {
  const landmarks = parseMapLandmarks(draft.landmarks, definition);
  const frame = parseAlignmentFrame(draft.frame), r = parseMapRegistration(draft.registration);
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 20 || new Set(rawIds).size !== rawIds.length || rawIds.some(id => typeof id !== "string" || !landmarks.some(p => p.object_id === id))) throw new Error("Select saved landmarks to correct");
  const ids = new Set<string>(rawIds), angle = r.rotation * Math.PI / 180;
  const scale = r.width / 100 * frame.width / definition.width;
  const moved = definition.objects.map(o => {
    if (!ids.has(o.id)) return o;
    const point = landmarks.find(p => p.object_id === o.id)!;
    const dx = (point.x - r.x) / 100 * frame.width / scale;
    const dz = (point.y - r.y) / 100 * frame.height / scale;
    return { ...o, x: definition.width / 2 + dx * Math.cos(angle) + dz * Math.sin(angle), z: definition.depth / 2 - dx * Math.sin(angle) + dz * Math.cos(angle) };
  });
  const next = { ...definition, objects: moved };
  // Validate without normalizing unrelated objects or rewriting their metadata.
  parsePlaceScene(next);
  validateOutdoorBuild(next, moved.filter(o => ids.has(o.id)));
  return next;
}
