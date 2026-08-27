import { describe, expect, it } from "vitest";

import { isDescentClipUrl, shouldAutoDescend } from "./descent-clip";

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
