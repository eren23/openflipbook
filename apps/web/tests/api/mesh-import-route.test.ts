// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ owner: vi.fn(), import: vi.fn() }));
vi.mock("@/lib/creator", async original => ({ ...(await original<object>()), requireCreator: f.owner }));
vi.mock("@/lib/mesh-import", () => ({ importMesh: f.import }));
import { CreatorError } from "@/lib/creator";
import { POST } from "@/app/api/world/[sessionId]/meshes/import/route";
const params = { params: Promise.resolve({ sessionId: "world" }) }, url = "http://localhost/api/world/world/meshes/import";
const post = (body = "binary", headers = {}) => POST(new Request(url, { method: "POST", body, headers: { "Content-Type": "model/gltf-binary", "X-Mesh-Filename": "Mesh.glb", ...headers } }), params);
beforeEach(() => { vi.resetAllMocks(); f.owner.mockResolvedValue({}); f.import.mockResolvedValue({ asset: { id: "imported" } }); });
it("gates origin, ownership, type and filename before import", async () => {
  expect((await post("", { Origin: "https://foreign.test" })).status).toBe(403); expect(f.owner).not.toHaveBeenCalled();
  f.owner.mockRejectedValueOnce(new CreatorError("Not owner", 403)); expect((await post()).status).toBe(403);
  expect((await post("", { "Content-Type": "text/plain" })).status).toBe(415);
  for (const filename of ["", "%ZZ", "x".repeat(501)]) expect((await post("", { "X-Mesh-Filename": filename })).status).toBe(400);
  expect(f.import).not.toHaveBeenCalled();
});
it("bounds declared and streamed bytes without handing oversized input to the parser", async () => {
  expect((await post("", { "Content-Length": "999999999" })).status).toBe(413);
  const chunk = new Uint8Array(1024 * 1024); let count = 0;
  const stream = new ReadableStream({ pull(controller) { if (++count <= 81) controller.enqueue(chunk); else controller.close(); } });
  const request = new Request(url, { method: "POST", headers: { "Content-Type": "model/gltf-binary", "X-Mesh-Filename": "Mesh.glb" }, body: stream, duplex: "half" } as RequestInit);
  expect((await POST(request, params)).status).toBe(413); expect(f.import).not.toHaveBeenCalled();
});
it("keeps imported bytes exact and responses private, with no provider dependency", async () => {
  const response = await post("exact bytes", { "X-Mesh-Filename": encodeURIComponent("Mesh with spaces.glb") });
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(response.headers.get("Vary")).toBe("Cookie");
  expect(f.import).toHaveBeenCalledWith("world", Buffer.from("exact bytes"), "Mesh with spaces.glb");
});
