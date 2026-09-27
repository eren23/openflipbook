import { isDeepStrictEqual } from "node:util";
import type { SceneDoc } from "./place-scene-store";
import { parseMapRegistration } from "./map-artwork";
import { archiveList, archiveObject, invalidArchive } from "./world-import-archive";
import { isSafeId } from "./ids";
import { parseMapLandmarks, parseAlignmentFrame } from "./map-alignment";

// Validate original identities before remapping. Otherwise a valid-looking head
// can attach unrelated pixels or a different registration to a restored place.
export function validateImportedMapArtwork(value: unknown, nodes: Record<string, unknown>[], scenes: SceneDoc[]) {
  const artwork = archiveObject(value);
  const versions = archiveList(artwork.versions, 500).map(archiveObject);
  const heads = archiveList(artwork.heads, 500).map(archiveObject);
  const pages = new Map(nodes.map(n => [n.id, n]));
  const byNode = new Map(versions.map(v => [v.node_id, v]));
  if (byNode.size !== versions.length) invalidArchive("Duplicate map artwork version");
  const requireNode = (id: unknown) => {
    if (!isSafeId(id) || !pages.has(id)) return invalidArchive("Map artwork page is missing");
    return pages.get(id)!;
  };
  for (const v of versions) {
    const output = requireNode(v.node_id), root = requireNode(v.map_root_node_id);
    const source = requireNode(v.scene_source_node_id); requireNode(v.base_map_node_id);
    if (output.id === root.id || output.parent_id !== v.base_map_node_id || (source.id === root.id ? source.parent_id != null : source.parent_id !== root.id)) invalidArchive("Map artwork page lineage differs from its binding");
    const scene = scenes.find(s => s.place_id === v.place_id && s.revision === v.scene_revision);
    const baseline = scenes.find(s => s.place_id === v.place_id && s.revision === v.baseline_revision);
    // SceneDoc page references have already been remapped, so resolve the source
    // against the export's stable scene identity here; caller checks source IDs.
    if (!scene || !baseline || scene.id !== v.scene_id || baseline.id !== v.scene_id || baseline.revision >= scene.revision
      || scene.definition.width !== baseline.definition.width || scene.definition.depth !== baseline.definition.depth) invalidArchive("Map artwork geometry baseline is unavailable or incompatible");
    parseMapRegistration(v.registration);
    const previous = byNode.get(v.base_map_node_id);
    if (v.base_map_node_id !== root.id && (!previous || previous.map_root_node_id !== root.id)) invalidArchive("Map artwork base belongs to another history");
  }
  const roots = new Set<unknown>(), reached = new Set<unknown>();
  for (const h of heads) {
    requireNode(h.map_root_node_id); requireNode(h.node_id);
    if (roots.has(h.map_root_node_id)) invalidArchive("Duplicate map artwork head");
    roots.add(h.map_root_node_id);
    let cursor: unknown = h.node_id;
    const chain: Record<string, unknown>[] = [], seen = new Set<unknown>();
    while (cursor !== h.map_root_node_id) {
      const v = byNode.get(cursor);
      if (!v || v.map_root_node_id !== h.map_root_node_id || seen.has(cursor)) invalidArchive("Map artwork history is cyclic or incomplete");
      seen.add(cursor); reached.add(cursor); chain.push(v!); cursor = v!.base_map_node_id;
    }
    if (!chain.length) invalidArchive("Map artwork head has no accepted version");
    const priorScenes = new Map<unknown, Record<string, unknown>>();
    for (const v of chain.reverse()) {
      const previous = priorScenes.get(v.scene_id);
      if (v.baseline_revision !== (previous?.scene_revision ?? 1) || previous && !isDeepStrictEqual(v.registration, previous.registration)) invalidArchive("Map artwork registration or baseline changed within its history");
      priorScenes.set(v.scene_id, v);
    }
  }
  if (reached.size !== versions.length) invalidArchive("Map artwork version is detached from its accepted head");
  const draftPlaces=new Set<string>();
  const drafts=archiveList(artwork.drafts??[],500).map(archiveObject).map(d=>{
    if(!isSafeId(d.place_id)||draftPlaces.has(d.place_id)||!Number.isSafeInteger(d.revision)||Number(d.revision)<1)invalidArchive("Invalid map alignment draft");
    draftPlaces.add(d.place_id as string);
    const source=requireNode(d.scene_source_node_id),map=requireNode(d.map_node_id),root=source.parent_id??source.id;
    const scene=scenes.find(s=>s.place_id===d.place_id&&s.id===d.scene_id&&s.revision===d.scene_revision);
    if(!scene || (map.id!==root && byNode.get(map.id)?.map_root_node_id!==root))invalidArchive("Map alignment source or geometry is unavailable");
    return {place_id:d.place_id as string,scene_id:d.scene_id,scene_revision:d.scene_revision,scene_source_node_id:source.id,map_node_id:map.id,
      revision:Number(d.revision),frame:parseAlignmentFrame(d.frame),landmarks:parseMapLandmarks(d.landmarks,scene!.definition),registration:parseMapRegistration(d.registration),updated_at:d.updated_at};
  });
  return { versions, heads, drafts };
}
