import type { GenerateRequestBody } from "@openflipbook/config";
import { getDb, type NodeDoc } from "./db";
import { envFlag } from "./env-flag";
import { frameCropToImageBox, geoTapForEntity, MAP_IMAGE_FRAME } from "./geo-tap";
import { toAbsoluteEntities } from "./world-geometry";
import { validReferenceBox } from "./place-identity";
import { isSafeId } from "./ids";
import { PlaceError } from "./places";
import { getStoredBytes } from "./r2";
import { getWorldMap } from "./world-map";
import { getWorldState } from "./world";

/** Resolve the target from our world, before reserving any generation spend. */
export async function resolvePlaceGeneration(body: GenerateRequestBody): Promise<GenerateRequestBody> {
  const next = { ...body };
  delete next.place_reference;
  delete next.strict_world;
  if (body.strict_world && !envFlag("WORLD_IDENTITY_STRICT")) throw new PlaceError("Strict world generation is not enabled on this server", 409);
  const strict = !!body.world_mode && !!body.strict_world;
  if (strict) next.strict_world = true;
  if (!body.target_geo_id && !strict) return next;
  if (!isSafeId(body.session_id) || !isSafeId(body.current_node_id)) throw new PlaceError("A saved source is required");
  const node = await (await getDb()).collection<NodeDoc>("nodes").findOne({ _id: body.current_node_id, session_id: body.session_id });
  if (!node) throw new PlaceError("Source is not in this world", 404);
  if (strict) {
    const source = await getStoredBytes(node.image_key);
    if (!source || !source.contentType.startsWith("image/") || source.bytes.length > 20 * 1024 * 1024) throw new PlaceError("Source image is unavailable", 422);
    next.image = `data:${source.contentType};base64,${source.bytes.toString("base64")}`;
    delete next.condition_image_urls;
    delete next.condition_roles;
    next.verify = true;
  }
  if (body.mode === "ascend") {
    if (strict) {
      if (node.scene_view) next.scene_view = node.scene_view;
      else delete next.scene_view;
      next.max_attempts = Math.min(2, body.max_attempts ?? 2);
    }
    return next;
  }
  if (!isSafeId(body.target_geo_id)) throw new PlaceError("Select a mapped place before generating a new view", 422);
  const map = await getWorldMap(body.session_id);
  const place = map.entities.find(e => e.id === body.target_geo_id && e.kind === "place");
  if (!place) throw new PlaceError("Place not found in this world", 404);
  next.prefetched_subject = place.label;
  next.prefetched_subject_context = place.visual;
  if (!strict) return next;
  const absolute = toAbsoluteEntities(map.entities, map.entities).find(e => e.id === place.id)!;
  const placeCrop = { x: absolute.pos.x - absolute.footprint.w / 2, y: absolute.pos.y - absolute.footprint.d / 2, w: absolute.footprint.w, h: absolute.footprint.d };
  const tap = geoTapForEntity(map, node._id, place, 16 / 9, node.scene_view, {
    ...(body.scene_view?.observer ? { observer: body.scene_view.observer } : {}),
    ...(body.scene_view?.view ? { view: body.scene_view.view } : {}),
    ...(body.scene_view?.level ? { level: body.scene_view.level } : {}),
  });
  const isZoom = body.render_mode === "place_submap" || body.render_mode === "place_closeup";
  next.scene_view = isZoom ? {
    ...tap.scene_view, level: body.render_mode === "place_submap" ? "map" : node.scene_view?.level ?? "building",
    observer: body.render_mode === "place_submap" ? null : node.scene_view?.observer ?? null,
    focus_id: place.id, closeup: true, map_crop: body.render_mode === "place_submap" ? placeCrop : null,
    ...(body.render_mode === "place_submap" ? { view: { projection: "top_down", source: "policy" } } : node.scene_view?.view ? { view: node.scene_view.view } : {}),
  } : tap.scene_view;
  next.expected_layout = isZoom ? [] : tap.expected_layout;
  next.prefetched_surroundings = tap.surroundings;
  next.surroundings_pov = tap.surroundings_pov ?? false;
  next.surroundings_behind = tap.surroundings_behind ?? "";
  const state = await getWorldState(body.session_id);
  next.world_context = [{ id: place.entity_id ?? place.id, kind: "place", name: place.label, aliases: [], appearance: place.visual, footprint: place.footprint, height: place.height, state: place.state }];
  const entity = state.entities.find(e => e.id === place.entity_id);
  const localBox = entity?.appearance_bboxes[node._id];
  const box = frameCropToImageBox(placeCrop, node.scene_view?.map_crop ?? MAP_IMAGE_FRAME);
  const fallback = localBox ?? (node.scene_view?.level === "map" || !node.scene_view ? { x_pct: box.x, y_pct: box.y, w_pct: box.w, h_pct: box.h } : null);
  let anchor = place.identity_anchor;
  // Uncurated places use their first recorded appearance, not the latest
  // generated view. Otherwise every revisit could ratchet a small drift.
  if (!anchor && entity?.first_seen_node_id) {
    const first = await (await getDb()).collection<NodeDoc>("nodes").findOne({ _id: entity.first_seen_node_id, session_id: body.session_id });
    const firstBox = entity.appearance_bboxes[entity.first_seen_node_id];
    if (first && firstBox) anchor = { node_id: first._id, image_key: first.image_key, bbox: firstBox };
  }
  anchor ??= fallback ? { node_id: node._id, image_key: node.image_key, bbox: fallback } : null;
  if (!anchor || !validReferenceBox(anchor.bbox)) throw new PlaceError("Choose a reference image for this place first", 422);
  const stored = await getStoredBytes(anchor.image_key);
  if (!stored || !stored.contentType.startsWith("image/") || stored.bytes.length > 20 * 1024 * 1024) throw new PlaceError("Place reference is unavailable", 422);
  next.place_reference = { geo_id: place.id, label: place.label, visual: place.visual, image_data_url: `data:${stored.contentType};base64,${stored.bytes.toString("base64")}`, bbox: anchor.bbox };
  next.max_attempts = Math.min(2, body.max_attempts ?? 2);
  return next;
}
