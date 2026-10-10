// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { CreatorError } from "@/lib/creator-error";
import type { StoredDescentVideo } from "@/lib/descent-clip";
const state = vi.hoisted(() => ({ get: vi.fn(), pin: vi.fn(), owner: vi.fn(), creator: vi.fn(), upload: vi.fn(), stored: vi.fn() }));
vi.mock("@/lib/db", () => ({ getNode: state.get, setNodeDescentClip: state.pin }));
vi.mock("@/lib/env", () => ({ readServerEnv: () => ({ MONGODB_URI: "fixture", MONGODB_DB: "fixture" }) }));
vi.mock("@/lib/session-owner", () => ({ requireOwner: state.owner }));
vi.mock("@/lib/creator", () => ({ requireCreator: state.creator }));
vi.mock("@/lib/r2", () => ({ uploadJpeg: state.upload, getStoredBytes: state.stored }));
vi.mock("@/lib/world-access", () => ({ requireWorldRead: vi.fn() }));
import { PATCH } from "@/app/api/nodes/[id]/route";
import { GET } from "@/app/api/nodes/[id]/descent-video/route";

function box(type: string, payload = Buffer.alloc(0)) { const bytes = Buffer.alloc(8 + payload.length); bytes.writeUInt32BE(bytes.length); bytes.write(type, 4, "ascii"); payload.copy(bytes, 8); return bytes; }
const mp4 = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov"), box("mdat", Buffer.from([1, 2, 3, 4]))]);
const sha = createHash("sha256").update(mp4).digest("hex");
const video: StoredDescentVideo = { version: 1, key: `world/descent-videos/child/${sha}.mp4`, sha256: sha, bytes: mp4.length, content_type: "video/mp4", parent_node_id: "parent", parent_image_key: "parent.png", node_image_key: "child.png" };
const child = { id: "child", parent_id: "parent", session_id: "world", image_key: "child.png", descent_video_url: null as string | null, descent_video: null as StoredDescentVideo | null };
const parent = { id: "parent", session_id: "world", image_key: "parent.png" };
const params = { params: Promise.resolve({ id: "child" }) };
const url = "https://v3b.fal.media/arrival.mp4";
const patch = (value: unknown = url) => PATCH(new Request("http://localhost/api/nodes/child", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ descent_video_url: value }) }), params);
const read = (range?: string) => GET(new Request("http://localhost/api/nodes/child/descent-video", { headers: range ? { range } : {} }), params);
beforeEach(() => {
  vi.unstubAllGlobals();
  for (const mock of Object.values(state)) mock.mockReset();
  state.get.mockImplementation(async (id: string) => id === "child" ? { ...child } : { ...parent });
  state.pin.mockResolvedValue(true); state.owner.mockResolvedValue({ ok: true }); state.creator.mockResolvedValue({}); state.upload.mockResolvedValue({});
  state.stored.mockResolvedValue({ bytes: mp4, contentType: "video/mp4" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(mp4), { headers: { "content-type": "video/mp4" } })));
});
it("denies unauthorized saves before provider or storage access", async () => {
  state.owner.mockResolvedValue({ ok: false, res: new Response("denied", { status: 403 }) });
  expect((await patch()).status).toBe(403); expect(fetch).not.toHaveBeenCalled(); expect(state.upload).not.toHaveBeenCalled(); expect(state.pin).not.toHaveBeenCalled();
});
it.each([null, { ...parent, session_id: "foreign" }])("requires a parent in the same owned world", async missing => {
  state.get.mockImplementation(async (id: string) => id === "child" ? child : missing);
  expect((await patch()).status).toBe(409); expect(fetch).not.toHaveBeenCalled(); expect(state.upload).not.toHaveBeenCalled();
});
it("pins exact MP4 bytes and source image keys, then returns the owner replay route", async () => {
  const res = await patch(); expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, kept: "/api/nodes/child/descent-video", durable: true });
  expect(state.upload.mock.calls[0]?.slice(0, 3)).toEqual([video.key, mp4, "video/mp4"]);
  expect(state.pin).toHaveBeenCalledWith("child", url, video);
});
it("migrates the same historical URL but retains different legacy URLs without copying or replacing", async () => {
  state.get.mockImplementation(async (id: string) => id === "child" ? { ...child, descent_video_url: url } : parent);
  expect((await patch()).status).toBe(200); expect(state.pin).toHaveBeenCalledOnce();
  vi.mocked(fetch).mockClear(); state.pin.mockClear();
  expect(await (await patch("https://fal.media/different.mp4")).json()).toEqual({ ok: true, kept: url, durable: false });
  expect(fetch).not.toHaveBeenCalled(); expect(state.pin).not.toHaveBeenCalled();
});
it("keeps historical foreign-host clips readable while rejecting new foreign-host saves", async () => {
  expect((await patch("https://evil.test/video.mp4")).status).toBe(400);
  state.get.mockResolvedValue({ ...child, descent_video_url: "https://old.example/video.mp4" });
  expect(await (await patch("https://old.example/video.mp4")).json()).toEqual({ ok: true, kept: "https://old.example/video.mp4", durable: false });
  expect(fetch).not.toHaveBeenCalled();
});
it("does not fetch or replace an already durable clip, even after a lost save acknowledgement", async () => {
  state.get.mockResolvedValue({ ...child, descent_video: video, descent_video_url: "/api/nodes/child/descent-video" });
  expect(await (await patch("https://fal.media/replacement.mp4")).json()).toEqual({ ok: true, kept: "/api/nodes/child/descent-video", durable: true });
  expect(fetch).not.toHaveBeenCalled(); expect(state.pin).not.toHaveBeenCalled();
});
it("honors the durable winner of a concurrent write and sanitizes storage failures", async () => {
  state.pin.mockResolvedValue(false); state.get.mockResolvedValueOnce(child).mockResolvedValueOnce(parent).mockResolvedValueOnce({ ...child, descent_video: video });
  expect(await (await patch()).json()).toMatchObject({ durable: true });
  state.get.mockImplementation(async (id: string) => id === "child" ? child : parent); state.upload.mockRejectedValue(new Error("secret storage credentials"));
  const res = await patch(); expect(res.status).toBe(503); expect(JSON.stringify(await res.json())).not.toContain("secret");
});
it("denies non-owner reads before opening the immutable blob", async () => {
  state.get.mockResolvedValue({ ...child, descent_video: video }); state.creator.mockRejectedValue(new CreatorError("Not owner", 403));
  expect((await read()).status).toBe(403); expect(state.stored).not.toHaveBeenCalled();
});
it("reopens exactly the stored MP4 with private caching and verified byte ranges", async () => {
  state.get.mockResolvedValue({ ...child, descent_video: video });
  const full = await read(); expect(full.status).toBe(200); expect(Buffer.from(await full.arrayBuffer())).toEqual(mp4);
  expect(full.headers.get("Cache-Control")).toBe("private, no-store"); expect(full.headers.get("Vary")).toBe("Cookie"); expect(full.headers.get("Content-Type")).toBe("video/mp4");
  const ranged = await read("bytes=3-9"); expect(ranged.status).toBe(206); expect(Buffer.from(await ranged.arrayBuffer())).toEqual(mp4.subarray(3, 10)); expect(ranged.headers.get("Content-Range")).toBe(`bytes 3-9/${mp4.length}`);
  const invalid = await read(`bytes=${mp4.length}-`); expect(invalid.status).toBe(416); expect(invalid.headers.get("Content-Range")).toBe(`bytes */${mp4.length}`);
});
it("serves complete verified bytes when If-Range is present and unvalidated", async () => {
  state.get.mockResolvedValue({ ...child, descent_video: video });
  const res = await GET(new Request("http://localhost/api", { headers: { range: "bytes=3-9", "if-range": '"old-entity"' } }), params);
  expect(res.status).toBe(200); expect(res.headers.get("Content-Range")).toBeNull(); expect(Buffer.from(await res.arrayBuffer())).toEqual(mp4);
});
it.each(["hash", "size", "type", "key"])("refuses altered stored %s without serving media", async field => {
  state.get.mockResolvedValue({ ...child, descent_video: field === "key" ? { ...video, key: "outside/../../secret" } : video });
  if (field === "hash") state.stored.mockResolvedValue({ bytes: Buffer.concat([mp4.subarray(0, -1), Buffer.from([9])]), contentType: "video/mp4" });
  if (field === "size") state.stored.mockResolvedValue({ bytes: mp4.subarray(0, -1), contentType: "video/mp4" });
  if (field === "type") state.stored.mockResolvedValue({ bytes: mp4, contentType: "text/html" });
  expect((await read()).status).toBe(422);
  if (field === "key") expect(state.stored).not.toHaveBeenCalled();
});
it("allows a private fork to replay its pinned historical bytes without access to the original world", async () => {
  state.get.mockResolvedValue({ ...child, session_id: "fork", parent_id: "fork-parent", descent_video: video });
  const res = await read(); expect(res.status).toBe(200); expect(state.creator).toHaveBeenCalledWith("fork"); expect(state.stored).toHaveBeenCalledWith(video.key, expect.any(AbortSignal));
});
