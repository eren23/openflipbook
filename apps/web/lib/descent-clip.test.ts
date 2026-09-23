import { describe, expect, it, vi } from "vitest";

import { isDescentClipUrl, saveDescentClip, shouldAutoDescend } from "./descent-clip";

const READY = {
  enabled: true,
  nodeId: "n1",
  parentImage: "https://r2/parent.png",
  currentImage: "data:image/jpeg;base64,AAAA",
  storedUrl: null,
  alreadyFired: false,
};

describe("shouldAutoDescend", () => {
  it("fires exactly when armed: flag, node, both frames, nothing stored", () => {
    expect(shouldAutoDescend(READY)).toBe(true);
  });

  it.each([
    ["flag off", { enabled: false }],
    ["unsaved node", { nodeId: null }],
    ["no parent frame", { parentImage: undefined }],
    ["no current frame", { currentImage: null }],
    ["clip already stored", { storedUrl: "https://fal.media/x.mp4" }],
    ["already in flight", { alreadyFired: true }],
  ])("stays quiet when %s", (_name, over) => {
    expect(shouldAutoDescend({ ...READY, ...over })).toBe(false);
  });
});

describe("isDescentClipUrl", () => {
  it("accepts a plain https video url", () => {
    expect(isDescentClipUrl("https://fal.media/files/x/clip.mp4")).toBe(true);
  });

  it.each([
    ["http", "http://fal.media/clip.mp4"],
    ["data uri", "data:video/mp4;base64,AAAA"],
    ["javascript", "javascript:alert(1)"],
    ["too short", "https://x"],
    ["not a string", 42],
    ["oversized", "https://" + "a".repeat(2100)],
  ])("rejects %s", (_name, value) => {
    expect(isDescentClipUrl(value)).toBe(false);
  });
});

// A saved clip replays for free; an unsaved one bills fal again on the next
// visit. The save used to be `void fetch(...).catch(() => {})`, and `fetch`
// resolves on a 4xx/5xx, so a failed save was never seen by anyone.
describe("saveDescentClip", () => {
  const reply = (status: number) => ({ ok: status < 400, status }) as Response;
  const sentTo = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([url]) => String(url));

  it("keeps the clip and reports nothing when the node accepts it", async () => {
    const send = vi.fn().mockResolvedValue(reply(200));
    await expect(saveDescentClip("n1", "https://v3b.fal.media/c.mp4", send)).resolves.toBe(true);
    expect(sentTo(send)).toEqual(["/api/nodes/n1"]);
  });

  it("reports a refused save instead of swallowing it -- the viewer who does not own the session", async () => {
    const send = vi.fn().mockResolvedValueOnce(reply(403)).mockResolvedValue(reply(200));
    await expect(saveDescentClip("n1", "https://v3b.fal.media/c.mp4", send)).resolves.toBe(false);
    expect(sentTo(send)).toEqual(["/api/nodes/n1", "/api/errors"]);
    const body = JSON.parse(String(send.mock.calls[1]![1]!.body));
    expect(body.kind).toBe("client.descent_clip_save");
    expect(body.message).toMatch(/HTTP 403/);
  });

  it("reports a network failure too", async () => {
    const send = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(reply(200));
    await expect(saveDescentClip("n1", "https://v3b.fal.media/c.mp4", send)).resolves.toBe(false);
    expect(JSON.parse(String(send.mock.calls[1]![1]!.body)).message).toMatch(/Failed to fetch/);
  });

  it("never throws, even when the error sink is down as well", async () => {
    const send = vi.fn().mockRejectedValue(new TypeError("offline"));
    await expect(saveDescentClip("n1", "https://v3b.fal.media/c.mp4", send)).resolves.toBe(false);
  });
});
