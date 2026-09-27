// @vitest-environment node
import { expect, it } from "vitest";
import JSZip from "jszip";
import sharp from "sharp";
import type { PlaceConnection, PlaceSceneSnapshot, WorldEntityGeo } from "@openflipbook/config";
import { archiveHash, readWorldArchive } from "./world-import-archive";
import { prepareWorldImport } from "./world-import-content";
import { buildWorldZip, type WorldExportNode } from "./export-build";
import { emptyPlaceScene, newComponent, sceneGeos } from "./place-scene";
import { adjacentPlacement, placeNetwork, networkView } from "./place-connections";
import { resolveSceneObject } from "./floor-placement";
import { buildingParts } from "./building-structure";
import { mapObject, mapRepaintState } from "./map-artwork";
import { materialAssetIds } from "./surface-material";

const now = new Date(0).toISOString();
async function fixture(rootReference=false,withDraft=false) {
  const image = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#68a496" } }).png().toBuffer();
  const painted = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#9faea3" } }).png().toBuffer();
  const tile = await sharp(image).jpeg().toBuffer();
  const binding = { asset_id: "stone", tile_metres: 2, rotation: 0.4, roughness: 0.8 };
  const building = newComponent("building", 20, 20);
  building.height = 7.8; building.structure!.floors.push({ id: "upper", label: "Upper room" });
  building.materials = { wall: binding, stair: binding };
  const bench = { ...newComponent("bench", 1, 0), placement: { building_id: building.id, floor_id: "upper" } };
  const base: PlaceSceneSnapshot = { id: "scene", session_id: "source", place_id: "place", revision: 1, source_node_id: rootReference?"map":"street", source_image_key: rootReference?"map.png":"street.png", updated_at: now,
    definition: { ...emptyPlaceScene(), objects: [building, bench], ground_material: binding } };
  const changed = structuredClone(base); changed.revision = 2; changed.definition.objects[0]!.height = 8.6;
  const third = structuredClone(changed); third.revision = 3; third.definition.objects[0]!.color = "#687572";
  const yard: PlaceSceneSnapshot = { ...base, id: "yard-scene", place_id: "yard", source_node_id: null, source_image_key: null, definition: { ...emptyPlaceScene(), label: "Workshop yard" } };
  const geos = sceneGeos(third, []);
  geos.push(...sceneGeos(yard, [adjacentPlacement(third, yard, "east", geos)]));
  const connection: PlaceConnection = { id: "east", version: 1, kind: "boundary", width: 3, created_at: now, a: { place_id: "place", side: "east", offset: 20 }, b: { place_id: "yard", side: "west", offset: 20 } };
  const page = (id: string, parent_id: string | null): WorldExportNode => ({ id, parent_id, title: id, query: id, created_at: now, relation: parent_id ? "edit" : "descend", scale_tier: null, click_in_parent: null, scene_view: null, sources: [], bytes: id.startsWith("paint") ? painted : image, content_type: "image/png",
    metadata: { image_key: `${id}.png`, image_model: "fixture", prompt_author_model: "fixture", aspect_ratio: "16:9", page_title: id } });
  const registration = { x: 50, y: 50, width: 40, rotation: 12 };
  const versions = [2, 3].map(revision => ({ node_id: `paint${revision}`, scene_id: "scene", place_id: "place", scene_revision: revision, baseline_revision: revision - 1,
    scene_source_node_id: rootReference?"map":"street", map_root_node_id: "map", base_map_node_id: revision === 2 ? "map" : "paint2", registration, created_at: new Date(revision).toISOString() }));
  const draft={place_id:"place",scene_id:"scene",scene_revision:3,scene_source_node_id:rootReference?"map":"street",map_node_id:"paint3",revision:2,frame:{width:320,height:180},landmarks:[{object_id:building.id,x:45,y:50}],registration,updated_at:now};
  const bytes = Buffer.from(await buildWorldZip([page("map", null), page("street", "map"), page("paint2", "map"), page("paint3", "paint2")],
    { session_id: "source", entities: geos, bounds: { x: 0, y: 0, w: 80, h: 40 }, schema_version: 1, updated_at: now }, { entities: [] }, [], [base, changed, third, yard], [],
    { heads: [{ node_id: "paint3", map_root_node_id: "map" }], versions, ...(withDraft?{drafts:[draft]}:{}) }, [], [connection],
    [{ id: "stone", sha256: archiveHash(tile), model: "fixture", prompt: "Stone fixture", request_id: "saved-provider-receipt", created_at: now, bytes: tile }], [],
    { session_id: "source", captured_at: now, visibility: "owner", scene_heads: [third, yard], entity_registry: null, workspace: { resume_place_id: "place" }, external_resources: [] }));
  return { bytes, third, yard, geos, connection, registration, tile, draft };
}
async function rewrite(bytes: Buffer, path: string, change: (value: any) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const zip = await JSZip.loadAsync(bytes), value = JSON.parse(await zip.file(path)!.async("string")); change(value);
  const data = Buffer.from(JSON.stringify(value)); zip.file(path, data);
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  Object.assign(manifest.files.find((f: { path: string }) => f.path === path), { bytes: data.length, sha256: archiveHash(data) });
  zip.file("manifest.json", JSON.stringify(manifest)); return zip.generateAsync({ type: "nodebuffer" });
}

it("round-trips map repaint history, connected frames, two floors and generated material bytes", async () => {
  const f = await fixture(), plan = await prepareWorldImport(await readWorldArchive(f.bytes), "restored");
  const scenes = plan.records.place_scenes as unknown as PlaceSceneSnapshot[], geos = plan.records.world_map![0]!.entities as WorldEntityGeo[];
  expect(scenes.map(s => s.definition)).toEqual([f.third.definition, f.yard.definition]);
  expect(plan.records.place_scene_versions).toHaveLength(4); expect(geos).toEqual(f.geos);
  const network = placeNetwork("place", scenes, geos, plan.records.place_connections as unknown as PlaceConnection[])!;
  expect(networkView(network, "place").definition.width).toBe(80);
  const restored = scenes.find(s => s.id === "scene")!;
  expect(buildingParts(restored.definition.objects[0]!)).toEqual(buildingParts(f.third.definition.objects[0]!));
  expect(resolveSceneObject(restored.definition, restored.definition.objects[1]!)).toMatchObject({ x: 21, z: 20, elevation: expect.closeTo(3.6) });
  expect(materialAssetIds(restored.definition)).toEqual(["stone"]);
  expect(plan.uploads.find(u => u.key === plan.records.material_assets![0]!.key)!.bytes).toEqual(f.tile);
  const page = (old: string) => plan.records.nodes!.find(n => n.restored_from.node_id === old)!;
  expect(restored.source_node_id).toBe(page("street")._id);
  expect(plan.records.map_artwork_heads![0]).toMatchObject({ node_id: page("paint3")._id, map_root_node_id: page("map")._id });
  expect(plan.records.map_artwork_versions![1]).toMatchObject({ base_map_node_id: page("paint2")._id, scene_source_node_id: page("street")._id, registration: f.registration, scene_revision: 3 });
  const object = restored.definition.objects[0]!, frame = { width: 1600, height: 900 };
  expect(mapObject(object, restored.definition, f.registration, frame)).toEqual(mapObject(f.third.definition.objects[0]!, f.third.definition, f.registration, frame));
  const edit = structuredClone(restored.definition); edit.objects[0]!.x += 1;
  expect(mapRepaintState(restored.definition, edit, f.registration, frame, 4).scene.elements.length).toBeGreaterThan(0);
});
it("round-trips root-place artwork and unaccepted landmark drafts with remapped source identities",async()=>{
  const f=await fixture(true,true),archive=await readWorldArchive(f.bytes);expect(archive.manifest.version).toBe(3);
  const plan=await prepareWorldImport(archive,"restored"),draft=plan.records.map_alignment_drafts![0]!;
  const page=(old:string)=>plan.records.nodes!.find(n=>n.restored_from.node_id===old)!;
  expect(draft).toMatchObject({_id:"restored:place",session_id:"restored",map_node_id:page("paint3")._id,scene_source_node_id:page("map")._id,landmarks:f.draft.landmarks,registration:f.registration,revision:2});
  expect(plan.records.map_artwork_versions).toHaveLength(2);expect(draft.accepted).toBeUndefined();
});
it.each(["object","frame","source","duplicate"])("rejects a checksum-valid alignment draft with wrong %s",async reason=>{
  const f=await fixture(true,true),bytes=await rewrite(f.bytes,"map-artwork.json",data=>{
    const d=data.drafts[0];if(reason==="object")d.landmarks[0].object_id="foreign";if(reason==="frame")d.frame.width=640;if(reason==="source")d.map_node_id="street";if(reason==="duplicate")data.drafts.push(d);
  });
  await expect(prepareWorldImport(await readWorldArchive(bytes),"restored")).rejects.toThrow();
});

it.each(["missing baseline", "wrong scene", "wrong source", "wrong parent", "different registration", "duplicate head", "missing head", "detached version", "wrong base", "invalid placement"])("rejects checksum-valid map import with %s", async reason => {
  const { bytes } = await fixture();
  const changed = await rewrite(bytes, reason === "wrong parent" ? "graph.json" : "map-artwork.json", data => {
    if (reason === "wrong parent") { data.nodes.find((n: { id: string }) => n.id === "paint3").parent_id = "map"; return; }
    const v = data.versions[1];
    if (reason === "missing baseline") v.baseline_revision = 99;
    if (reason === "wrong scene") v.scene_id = "yard-scene";
    if (reason === "wrong source") v.scene_source_node_id = "paint2";
    if (reason === "different registration") v.registration.rotation = 20;
    if (reason === "duplicate head") data.heads.push(data.heads[0]);
    if (reason === "missing head") data.heads = [];
    if (reason === "detached version") data.heads[0].node_id = "paint2";
    if (reason === "wrong base") v.base_map_node_id = "street";
    if (reason === "invalid placement") v.registration.width = 200;
  });
  await expect(prepareWorldImport(await readWorldArchive(changed), "restored")).rejects.toThrow(/map artwork|map placement/i);
});
it("rejects a connected world whose archive places no longer meet", async () => {
  const { bytes } = await fixture();
  const changed = await rewrite(bytes, "world-map.json", map => { map.entities.find((g: { id: string }) => g.id === "yard").pos.x += 2; });
  await expect(prepareWorldImport(await readWorldArchive(changed), "restored")).rejects.toThrow("align");
});
it("rejects a missing bound material instead of restoring untextured architecture", async () => {
  const { bytes } = await fixture();
  const changed = await rewrite(bytes, "surface-materials.json", materials => { materials.length = 0; });
  await expect(prepareWorldImport(await readWorldArchive(changed), "restored")).rejects.toThrow("missing material");
});
it("rejects two page images claiming the same original storage key with different bytes", async () => {
  const { bytes } = await fixture();
  const changed = await rewrite(bytes, "graph.json", graph => { graph.nodes.find((n: { id: string }) => n.id === "paint2").image_key = "map.png"; });
  await expect(prepareWorldImport(await readWorldArchive(changed), "restored")).rejects.toThrow("conflicting bytes");
});
