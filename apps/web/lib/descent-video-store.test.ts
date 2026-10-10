// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const upload = vi.hoisted(() => vi.fn());
vi.mock("./r2", () => ({ uploadJpeg: upload }));
import { descentByteRange, descentProviderUrl, downloadDescentVideo, MAX_DESCENT_VIDEO_BYTES, storeDescentVideo, validStoredDescentVideo, validateDescentMp4 } from "./descent-video-store";

function box(type: string, payload = Buffer.alloc(0)) { const bytes = Buffer.alloc(8 + payload.length); bytes.writeUInt32BE(bytes.length); bytes.write(type, 4, "ascii"); payload.copy(bytes, 8); return bytes; }
const mp4 = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov"), box("mdat", Buffer.from([1, 2, 3, 4]))]);
const response = (bytes: Uint8Array = mp4, headers: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { headers: { "content-type": "video/mp4", ...headers } });
beforeEach(() => { vi.unstubAllGlobals(); upload.mockReset().mockResolvedValue({}); });

it.each(["http://fal.media/a.mp4", "https://fal.media.evil.test/a", "https://evilfal.media/a", "https://user:pass@fal.media/a", "https://fal.media:8443/a", "https://127.0.0.1/a"])("refuses unsupported download URL %s", value => { expect(() => descentProviderUrl(value)).toThrow("Unsupported"); });
it("stores exactly the downloaded bytes, including all payload bytes, in a content-addressed owner prefix", async () => {
  const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", fetcher);
  const video = await storeDescentVideo({ session_id: "session_one", node_id: "child", parent_node_id: "parent", parent_image_key: "parent.png", node_image_key: "child.png", url: "https://v3b.fal.media/clip.mp4" });
  const sha = createHash("sha256").update(mp4).digest("hex");
  expect(video).toEqual({ version: 1, key: `session_one/descent-videos/child/${sha}.mp4`, sha256: sha, bytes: mp4.length, content_type: "video/mp4", parent_node_id: "parent", parent_image_key: "parent.png", node_image_key: "child.png" });
  expect(upload.mock.calls[0]?.slice(0, 3)).toEqual([video.key, mp4, "video/mp4"]);
  expect(fetcher).toHaveBeenCalledWith("https://v3b.fal.media/clip.mp4", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  expect(validStoredDescentVideo(video)).toBe(true);
  expect(validStoredDescentVideo({ ...video, key: "foreign/../../../secret" })).toBe(false);
});
it.each(["text/html", "image/png", "application/octet-stream"])("refuses %s before storing", async contentType => {
  await expect(downloadDescentVideo("https://fal.media/a", vi.fn().mockResolvedValue(response(mp4, { "content-type": contentType })))).rejects.toThrow("Expected MP4");
  expect(upload).not.toHaveBeenCalled();
});
it("refuses declared oversize, HTTP errors, and incomplete downloads", async () => {
  await expect(downloadDescentVideo("https://fal.media/a", vi.fn().mockResolvedValue(response(mp4, { "content-length": String(MAX_DESCENT_VIDEO_BYTES + 1) })))).rejects.toMatchObject({ status: 413 });
  await expect(downloadDescentVideo("https://fal.media/a", vi.fn().mockResolvedValue(new Response("no", { status: 403 })))).rejects.toMatchObject({ status: 502 });
  await expect(downloadDescentVideo("https://fal.media/a", vi.fn().mockResolvedValue(response(mp4, { "content-length": String(mp4.length + 1) })))).rejects.toThrow("Incomplete");
});
it("caps a chunked download even without Content-Length and cancels the stream", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_DESCENT_VIDEO_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel });
  await expect(downloadDescentVideo("https://fal.media/a", vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "video/mp4" } })))).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
});
it("rejects truncated, malformed, and incomplete MP4 containers", () => {
  expect(() => validateDescentMp4(mp4)).not.toThrow();
  expect(() => validateDescentMp4(mp4.subarray(0, -1))).toThrow();
  expect(() => validateDescentMp4(Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(8))]))).toThrow();
  const corrupt = Buffer.from(mp4); corrupt.writeUInt32BE(2, 16); expect(() => validateDescentMp4(corrupt)).toThrow();
});
it("supports full, bounded, open-ended and suffix video ranges while rejecting multiple or invalid ranges", () => {
  expect(descentByteRange(null, 40)).toBeNull();
  expect(descentByteRange("bytes=3-7", 40)).toEqual({ start: 3, end: 7 });
  expect(descentByteRange("bytes=38-", 40)).toEqual({ start: 38, end: 39 });
  expect(descentByteRange("bytes=-8", 40)).toEqual({ start: 32, end: 39 });
  expect(descentByteRange("bytes=0-100", 40)).toEqual({ start: 0, end: 39 });
  for (const value of ["bytes=40-", "bytes=-0", "bytes=8-2", "bytes=0-1,3-4", "bytes=-"]) expect(() => descentByteRange(value, 40)).toThrow();
});
