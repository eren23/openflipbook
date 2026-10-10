// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { CreatorError } from "./creator-error";
const state = vi.hoisted(() => ({ metadata: null as { _id: string } | null, owner: null as { _id: string } | null, nodes: [] as { session_id: string }[], read: vi.fn(), creator: vi.fn(), stored: vi.fn(), fail: false }));
vi.mock("./db", () => ({ getDb: async () => ({ collection: (name: string) => ({ findOne: async () => { if (state.fail) throw new Error("private credentials"); return name === "session_owners" ? state.owner : state.metadata; },
  find: () => ({ limit: () => ({ toArray: async () => state.nodes }) }) }) }) }));
vi.mock("./world-access", () => ({ requireWorldRead: state.read }));
vi.mock("./creator", () => ({ requireCreator: state.creator }));
vi.mock("./r2", () => ({ getStoredBytes: state.stored }));
import { requireStoredImageRead, validStoredImageKey } from "./stored-image-access";
import { GET } from "@/app/api/blobs/[...key]/route";
const get = (key = ["world", "image.png"]) => GET(new Request("http://localhost/api/blobs/world/image.png"), { params: Promise.resolve({ key }) });
beforeEach(() => { state.metadata = null; state.owner = null; state.nodes = []; state.fail = false; state.read.mockReset().mockResolvedValue(undefined); state.creator.mockReset().mockResolvedValue(undefined); state.stored.mockReset().mockResolvedValue({ bytes: Buffer.from([1]), contentType: "image/png" }); });
it("serves a creator's private sketch candidate before acceptance while denying another browser", async () => {
  state.owner = { _id: "world" }; expect((await get()).status).toBe(200); expect(state.creator).toHaveBeenCalledWith("world"); expect(state.read).not.toHaveBeenCalled();
  state.creator.mockRejectedValue(new CreatorError("Not owner", 403)); state.stored.mockClear();
  expect((await get()).status).toBe(403); expect(state.stored).not.toHaveBeenCalled();
});
it("allows private creator images only after ownership, with cookie-private response caching", async () => {
  state.metadata = { _id: "world" };
  const response = await get(); expect(response.status).toBe(200); expect(state.read).toHaveBeenCalledWith("world");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(response.headers.get("Vary")).toBe("Cookie"); expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  state.read.mockRejectedValue(new CreatorError("Not owner", 403)); state.stored.mockClear();
  expect((await get()).status).toBe(403); expect(state.stored).not.toHaveBeenCalled();
});
it("retains intentional legacy-public node images without exposing unclaimed import or upload prefixes", async () => {
  expect((await get()).status).toBe(403); expect(state.read).not.toHaveBeenCalled();
  state.nodes = [{ session_id: "legacy" }]; expect((await get()).status).toBe(200); expect(state.read).toHaveBeenCalledWith("legacy");
});
it("allows an owned fork's persisted immutable node image when its original prefix is private", async () => {
  state.metadata = { _id: "world" }; state.nodes = [{ session_id: "fork" }];
  state.read.mockImplementation(async (sid: string) => { if (sid === "world") throw new CreatorError("Not owner", 403); });
  await expect(requireStoredImageRead("world/image.png")).resolves.toBeUndefined(); expect(state.read).toHaveBeenCalledWith("fork");
});
it.each(["world/../secret.png", "world/./image.png", "../world/a.png", "world//a.png", "world/a%2fsecret.png", "a.png", "world/secret.svg?x"])("rejects ambiguous storage path %s before reading metadata or storage", async key => {
  expect(validStoredImageKey(key)).toBe(false); expect((await get(key.split("/"))).status).toBe(400); expect(state.stored).not.toHaveBeenCalled();
});
it("sanitizes authorization outages and refuses archive or active image formats", async () => {
  state.fail = true; const outage = await get(); expect(outage.status).toBe(503); expect(await outage.text()).not.toContain("credentials");
  state.fail = false; state.metadata = { _id: "world" }; state.stored.mockResolvedValue({ bytes: Buffer.from([1]), contentType: "image/svg+xml" });
  expect((await get()).status).toBe(422); state.stored.mockResolvedValue({ bytes: Buffer.from([1]), contentType: "application/zip" }); expect((await get()).status).toBe(422);
});
