// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ owner: vi.fn(), save: vi.fn(), list: vi.fn(), read: vi.fn(), bytes: vi.fn() }));
vi.mock("@/lib/creator", async original => ({ ...(await original<object>()), requireCreator: f.owner }));
vi.mock("@/lib/mesh-source", () => ({ MAX_MESH_SOURCE_BYTES: 12 * 1024 * 1024, saveMeshSource: f.save, meshSources: f.list, readMeshSource: f.read, meshSourceBytes: f.bytes }));
import { CreatorError } from "@/lib/creator";
import { GET, POST } from "@/app/api/world/[sessionId]/meshes/sources/route";
import { GET as image } from "@/app/api/world/[sessionId]/meshes/sources/[sourceId]/route";
const params = { params: Promise.resolve({ sessionId: "world" }) };
const url = "http://localhost/api/world/world/meshes/sources";
const post = (body: string, headers: Record<string, string> = {}) => POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }), params);
beforeEach(() => { vi.resetAllMocks(); f.owner.mockResolvedValue({}); f.save.mockResolvedValue({ source: { id: "saved" } }); f.list.mockResolvedValue({ sources: [] }); f.read.mockResolvedValue({ id: "saved" }); f.bytes.mockResolvedValue(Buffer.from([1, 2, 3])); });
it("checks origin, type and ownership before reading an upload", async () => {
  expect((await post("{}", { Origin: "https://foreign.test" })).status).toBe(403); expect(f.owner).not.toHaveBeenCalled();
  expect((await post("{}", { "Content-Type": "text/plain" })).status).toBe(415);
  f.owner.mockRejectedValue(new CreatorError("Not owner", 403)); expect((await post("not-json")).status).toBe(403); expect(f.save).not.toHaveBeenCalled();
});
it("bounds declared and streamed request bytes and rejects malformed JSON before storage", async () => {
  expect((await post("{}", { "Content-Length": "99999999" })).status).toBe(413);
  expect((await post("x".repeat(17 * 1024 * 1024))).status).toBe(413);
  for (const body of ["bad", "null", "[]", "3"]) expect((await post(body)).status).toBe(400);
  expect(f.save).not.toHaveBeenCalled();
});
it("serves only private uncached source metadata and validated input bytes", async () => {
  const saved = await post(JSON.stringify({ node_id: "accepted" })); expect(saved.status).toBe(200);
  expect(f.save).toHaveBeenCalledWith("world", { node_id: "accepted" });
  const list = await GET(new Request(url), params); expect(list.headers.get("Cache-Control")).toBe("private, no-store");
  const result = await image(new Request(url), { params: Promise.resolve({ sessionId: "world", sourceId: "saved" }) });
  expect(result.headers.get("Content-Type")).toBe("image/png"); expect(result.headers.get("Vary")).toBe("Cookie"); expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(Buffer.from(await result.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  f.owner.mockRejectedValue(new CreatorError("Not owner", 403)); expect((await image(new Request(url), { params: Promise.resolve({ sessionId: "world", sourceId: "saved" }) })).status).toBe(403);
  expect(f.bytes).toHaveBeenCalledTimes(1);
});
