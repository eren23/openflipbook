// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import type { snapshotWorldExport } from "@/lib/world-export-snapshot";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), stored: vi.fn(), views: vi.fn(async () => []), configured: true }));
vi.mock("@/lib/world-export-snapshot", () => ({ snapshotWorldExport: mocks.snapshot }));
vi.mock("@/lib/r2", () => ({ getStoredBytes: mocks.stored }));
vi.mock("@/lib/place-view-server", () => ({ downloadPlaceViewExports: mocks.views }));
vi.mock("@/lib/env", () => ({ readServerEnv: () => ({ MONGODB_URI: mocks.configured ? "mongo" : null, MONGODB_DB: "test" }) }));
import { GET } from "@/app/api/export/session/[sessionId]/route";
import { CreatorError } from "@/lib/creator-error";
const bytes = Buffer.from([1, 2, 3]), sha256 = createHash("sha256").update(bytes).digest("hex");
let snapshot: Awaited<ReturnType<typeof snapshotWorldExport>>;
const get = () => GET(new Request("http://localhost/api/export/session/world"), { params: Promise.resolve({ sessionId: "world" }) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.configured = true; mocks.stored.mockResolvedValue({ bytes, contentType: "image/png" }); mocks.views.mockResolvedValue([]);
  snapshot = { session_id: "world", captured_at: "2026-09-13T00:00:00.000Z", privateOwner: true,
    nodes: [{ _id: "node", session_id: "world", parent_id: null, query: "City", page_title: "City", image_key: "city.png", image_model: "saved-model", prompt_author_model: "planner", final_prompt: "A detailed city", aspect_ratio: "16:9", click_in_parent: null,
      created_at: new Date(1), geo_extracted_at: new Date(2), descent_video_url: "https://foreign.example/saved.mp4" }],
    scenes: [], sceneHeads: [], worldMap: { session_id: "world", entities: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, schema_version: 1, updated_at: new Date(0) }, entities: { session_id: "world", entities: [], updated_at: new Date(0) },
    registry: { _id: "world", entities: [{ id: "gone", deleted_at: new Date(3) }] }, workspace: { title: "World", archived: false, resume_node_id: "node", resume_place_id: null, resume_view: null, walk_position: null },
    meshes: [], materials: [], artwork: { heads: [], versions: [], drafts: [] }, connections: [], views: [], motion: { studies: [], assets: [], reviews: [], selections: [] },
  } as Awaited<ReturnType<typeof snapshotWorldExport>>;
  mocks.snapshot.mockImplementation(async () => structuredClone(snapshot));
});
it("downloads an intact checksummed snapshot with provenance and original PNG encoding", async () => {
  const response = await get(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const graph = JSON.parse(await zip.file("graph.json")!.async("string"));
  expect(graph.nodes[0]).toMatchObject({ id: "node", image_model: "saved-model", prompt_author_model: "planner", final_prompt: "A detailed city", geo_extracted_at: new Date(2).toISOString(), aspect_ratio: "16:9", image: "pages/001-City.png" });
  expect(graph.nodes[0]).not.toHaveProperty("_id");
  expect(JSON.parse(await zip.file("entity-registry.json")!.async("string")).entities[0].deleted_at).toBe(new Date(3).toISOString());
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  expect(manifest).toMatchObject({ format: "openflipbook-world-content", version: 1, metadata_consistency: "database_snapshot", visibility: "owner", missing_files: [], restore_supported: false,
    external_resources: [{ kind: "arrival_video", node_id: "node", url: "https://foreign.example/saved.mp4" }] });
  expect(manifest.files.map((f: { path: string }) => f.path).sort()).toEqual(Object.values(zip.files).filter(f => !f.dir && f.name !== "manifest.json").map(f => f.name).sort());
  for (const file of manifest.files) {
    const data = await zip.file(file.path)!.async("nodebuffer"); expect(data.length).toBe(file.bytes); expect(createHash("sha256").update(data).digest("hex")).toBe(file.sha256);
  }
  expect(mocks.stored).toHaveBeenCalledTimes(1); expect(mocks.stored).toHaveBeenCalledWith("city.png", expect.any(AbortSignal));
});
it.each([null, { bytes: Buffer.alloc(0), contentType: "image/png" }])("refuses missing page bytes instead of returning a partial ZIP", async stored => {
  mocks.stored.mockResolvedValue(stored); const response = await get(); expect(response.status).toBe(503); expect(response.headers.get("Content-Type")).toContain("json"); expect(await response.json()).toMatchObject({ error: expect.stringContaining("nothing was exported") });
});
it("includes immutable transition reference images and rejects missing references", async () => {
  snapshot.nodes[0]!.transition_context = { version: 1, source_image_key: "before-edit.png" } as never;
  const response = await get(); expect(response.status).toBe(200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  expect(JSON.parse(await zip.file("references.json")!.async("string"))[0].image_key).toBe("before-edit.png");
  mocks.stored.mockImplementation(async key => key === "before-edit.png" ? null : { bytes, contentType: "image/png" });
  expect((await get()).status).toBe(503);
});
it("does not silently truncate more than 500 reference images", async () => {
  snapshot.worldMap.entities = Array.from({ length: 501 }, (_, i) => ({ identity_anchor: { image_key: `${i}.png` } })) as never;
  expect((await get()).status).toBe(413);
});
it.each(["length", "hash", "budget"])("rejects saved mesh %s mismatches before returning an archive", async kind => {
  snapshot.meshes = [{ id: "mesh", key: "mesh.glb", bytes: kind === "length" ? 4 : kind === "budget" ? 201 * 1024 * 1024 : 3, sha256: kind === "hash" ? "0".repeat(64) : sha256 }] as never;
  expect((await get()).status).toBe(kind === "budget" ? 413 : 503);
});
it("exports only snapshot data even when storage downloads overlap a new edit", async () => {
  mocks.stored.mockImplementation(async () => { snapshot.nodes[0]!.image_model = "later-model"; return { bytes, contentType: "image/png" }; });
  const response = await get(); const zip = await JSZip.loadAsync(await response.arrayBuffer());
  expect(JSON.parse(await zip.file("graph.json")!.async("string")).nodes[0].image_model).toBe("saved-model"); expect(snapshot.nodes[0]!.image_model).toBe("later-model");
});
it("omits private workspace and registry from shared bundles", async () => {
  snapshot.privateOwner = false; snapshot.workspace = null; snapshot.registry = null;
  const zip = await JSZip.loadAsync(await (await get()).arrayBuffer()); expect(zip.file("workspace.json")).toBeNull(); expect(zip.file("entity-registry.json")).toBeNull();
});
it("returns private fail-closed authorization, configuration and unexpected errors", async () => {
  mocks.snapshot.mockRejectedValue(new CreatorError("Not owner", 403)); expect((await get()).status).toBe(403);
  mocks.snapshot.mockRejectedValue(new Error("secret database credentials"));
  const response = await get(); expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret"); expect(response.headers.get("Vary")).toBe("Cookie");
  mocks.configured = false; expect((await get()).status).toBe(503);
});
it("includes saved motion binaries and fails closed on a missing or corrupted reference", async () => {
  const file = { key: "motion.png", sha256, bytes: bytes.length };
  snapshot.motion.studies = [{ id: "study", source: { image: file }, files: [{ render: file, depth: file, normals: file, objects: file }] }] as never;
  const response = await get(); expect(response.status).toBe(200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  expect(JSON.parse(await zip.file("manifest.json")!.async("string")).version).toBe(2);
  expect(JSON.parse(await zip.file("motion.json")!.async("string")).files).toHaveLength(1);
  mocks.stored.mockImplementation(async key => key === "motion.png" ? null : { bytes, contentType: "image/png" });
  expect((await get()).status).toBe(503);
  mocks.stored.mockImplementation(async key => ({ bytes: key === "motion.png" ? Buffer.from("bad") : bytes, contentType: "image/png" }));
  expect((await get()).status).toBe(503);
});
