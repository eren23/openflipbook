import type { PlaceSceneDefinition } from "@openflipbook/config";

export const WORLD_EDITOR_VIEWS = ["plan", "orbit", "walk", "reference", "split", "illustration"] as const;
export type WorldEditorView = typeof WORLD_EDITOR_VIEWS[number];
export interface WorldEditorSelection { object_id: string | null; floor_id: string | null }

export function walkVideoViewIds(value: string | null): string[] {
  const ids = value?.split(",") ?? [];
  return ids.length >= 2 && ids.length <= 12 && new Set(ids).size === ids.length && ids.every(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id)) ? ids : [];
}

// Resolve IDs against this place, never labels or another chunk's object list.
// Furnishings carry their floor with them; an outdoor selection leaves a room.
export function worldEditorSelection(definition: PlaceSceneDefinition, objectId: string | null, floorId: string | null): WorldEditorSelection {
  const object = definition.objects.find(o => o.id === objectId);
  if (object?.placement) return { object_id: object.id, floor_id: object.placement.floor_id };
  const owner = floorId ? definition.objects.find(o => o.structure?.floors.some(f => f.id === floorId)) : undefined;
  return { object_id: object?.id ?? null, floor_id: owner && (!object || object.id === owner.id) ? floorId : null };
}

export function worldEditorHref(context: { session_id: string; place_id: string }, selection: WorldEditorSelection,
  options: { map?: boolean; view?: WorldEditorView; camera?: string | null; route?: string | null; workflow?: "illustrated-walk" } = {}) {
  const query = new URLSearchParams({ world: context.session_id, place: context.place_id });
  if (selection.object_id) query.set("object", selection.object_id);
  if (selection.floor_id) query.set("floor", selection.floor_id);
  if (options.view) query.set("view", options.view);
  if (options.camera) query.set("camera", options.camera);
  // A /play walk handed over (walk-position routeQuery).
  if (options.route) query.set("route", options.route);
  if (options.workflow) query.set("workflow", options.workflow);
  return `/sketch/world${options.map ? "/map" : ""}?${query}`;
}
