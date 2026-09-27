// @vitest-environment node
import { expect, it } from "vitest";
import JSZip from "jszip";
import { archiveHash, readWorldArchive } from "./world-import-archive";
import { buildWorldZip } from "./export-build";
import { prepareWorldImport } from "./world-import-content";
import { emptyPlaceScene } from "./place-scene";
import sharp from "sharp";

export async function archiveFixture() {
  const definition = emptyPlaceScene(), scene = { id: "scene", place_id: "place", session_id: "source", revision: 1, source_node_id: null, source_image_key: null, updated_at: new Date(0).toISOString(), definition };
  return Buffer.from(await buildWorldZip([], { session_id: "source", entities: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, schema_version: 1, updated_at: new Date(0) }, { entities: [] }, [], [scene], [], undefined, [], [], [], [], {
    session_id: "source", captured_at: new Date(0).toISOString(), visibility: "owner", scene_heads: [scene], entity_registry: null, workspace: { title: "Original world", resume_place_id: "place" }, external_resources: [],
  }));
}
async function mutate(path: string, value: unknown, updateHash = true) {
  const zip = await JSZip.loadAsync(await archiveFixture());
  const bytes = Buffer.from(JSON.stringify(value)); zip.file(path, bytes);
  if (updateHash) {
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")), entry = manifest.files.find((f: { path: string }) => f.path === path);
    entry.bytes = bytes.length; entry.sha256 = archiveHash(bytes); zip.file("manifest.json", JSON.stringify(manifest));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}
it("prepares a portable source-free world without creating any storage or database records", async () => {
  const archive = await readWorldArchive(await archiveFixture()), plan = await prepareWorldImport(archive, "destination");
  expect(plan.preview).toMatchObject({ places: 1, pages: 0, objects: 0, views: 0, title: "Original world" });
  expect(plan.records.place_scenes![0]).toMatchObject({ _id: "destination:place", session_id: "destination", id: "scene", revision: 1 });
  expect(plan.records.creator_worlds![0]).toMatchObject({ visibility: "private", resume_place_id: "place", imported_from: { provenance: "user_supplied_archive" } });
  expect(plan.uploads).toEqual([]); expect(plan.records).not.toHaveProperty("session_owners");
});
it("remaps global page identities and image references while retaining entity tombstones and extraction receipts", async () => {
  const archive = await readWorldArchive(await archiveFixture()), originalJson = archive.json;
  archive.files.set("page.png", await sharp({ create: { width: 32, height: 32, channels: 4, background: "#68a496" } }).png().toBuffer());
  const page = { query: "City", title: "City", page_title: "City", image: "page.png", image_key: "original.png", image_model: "saved-model", prompt_author_model: "planner", aspect_ratio: "16:9", final_prompt: "City prompt", created_at: new Date(0).toISOString(), geo_extracted_at: new Date(1).toISOString() };
  archive.json = path => path === "graph.json" ? { nodes: [{ ...page, id: "a", parent_id: null }, { ...page, id: "b", parent_id: "a", scene_view: { node_id: "b" } }] }
    : path === "entity-registry.json" ? { _id: "source", updated_at: new Date(0).toISOString(), entities: [{ id: "entity", first_seen_node_id: "a", last_seen_node_id: "b", appears_on_node_ids: ["a", "b"], appearance_bboxes: { a: [1, 2, 3, 4] }, updated_at: new Date(0).toISOString(), deleted_at: new Date(2).toISOString() }] }
    : originalJson(path);
  const plan = await prepareWorldImport(archive, "destination"), [a, b] = plan.records.nodes!;
  expect(a!._id).not.toBe("a"); expect(b!.parent_id).toBe(a!._id); expect(b!.scene_view.node_id).toBe(b!._id);
  expect(a!.image_key).toMatch(/^destination\/restored\//); expect(a!.geo_extracted_at).toEqual(new Date(1)); expect(a!.image_model).toBe("saved-model");
  const e = plan.records.world_state![0]!.entities[0]; expect(e.appears_on_node_ids).toEqual([a!._id, b!._id]); expect(e.deleted_at).toEqual(new Date(2)); expect(e.appearance_bboxes[a!._id]).toEqual([1, 2, 3, 4]);
});
it("rejects a corrupted entry even when it still parses as JSON", async () => {
  await expect(readWorldArchive(await mutate("graph.json", { nodes: [1] }, false))).rejects.toMatchObject({ status: 422 });
});
it("rejects forged metadata that has a correct checksum but invalid scene geometry", async () => {
  const bytes = await mutate("place-scenes.json", [{ id: "scene", place_id: "place", revision: 1, definition: { ...emptyPlaceScene(), width: 1000000 } }]);
  await expect(prepareWorldImport(await readWorldArchive(bytes), "destination")).rejects.toThrow("dimensions");
});
it("rejects missing scene versions rather than inventing history", async () => {
  await expect(prepareWorldImport(await readWorldArchive(await mutate("place-scenes.json", [])), "destination")).rejects.toMatchObject({ status: 422 });
});
it.each(["../../escape.txt", "/absolute.txt", "unlisted.txt"])("rejects unsafe or unlisted archive path %s", async path => {
  const zip = await JSZip.loadAsync(await archiveFixture()); zip.file(path, "extra");
  await expect(readWorldArchive(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toMatchObject({ status: 422 });
});
it("bounds decompression even when declared inventory sizes lie", async () => {
  const zip = await JSZip.loadAsync(await archiveFixture()); zip.file("graph.json", "x".repeat(1024 * 1024));
  await expect(readWorldArchive(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))).rejects.toMatchObject({ status: 413 });
});
it.each(["owner_credentials", "__proto__", "$set", "nested.key"])("never publishes arbitrary archive metadata %s", async key => {
  const raw = { [key]: { dangerous: true } }, bytes = await mutate("workspace.json", raw);
  if (key === "owner_credentials") {
    const plan = await prepareWorldImport(await readWorldArchive(bytes), "destination"); expect(plan.records.creator_worlds![0]).not.toHaveProperty(key);
  } else await expect(prepareWorldImport(await readWorldArchive(bytes), "destination")).rejects.toMatchObject({ status: 422 });
});
it.each(["shared", "external", "missing", "future"])("rejects unsupported %s archive instead of silently losing content", async mode => {
  const zip = await JSZip.loadAsync(await archiveFixture()), m = JSON.parse(await zip.file("manifest.json")!.async("string"));
  if (mode === "shared") m.visibility = "shared";
  if (mode === "external") m.external_resources = [{ url: "https://example.com/movie.mp4" }];
  if (mode === "missing") m.missing_files = [{ id: "gone" }];
  if (mode === "future") m.version = 999;
  zip.file("manifest.json", JSON.stringify(m));
  await expect(readWorldArchive(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toMatchObject({ status: 422 });
});
