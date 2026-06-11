import { describe, expect, it, vi } from "vitest";

import {
  MAX_RECONNECTS,
  reconnectDelayMs,
  startLTXStream,
} from "./stream-client";

describe("reconnectDelayMs", () => {
  it("backs off 500ms → 1s → 2s, capped at 4s", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(5)).toBe(4000);
    expect(MAX_RECONNECTS).toBeGreaterThan(0);
  });
});

describe("startLTXStream degraded fallback", () => {
  it("no MediaSource (this test env) → degraded_to_image immediately, no socket", () => {
    const onStatus = vi.fn();
    const onError = vi.fn();
    const client = startLTXStream({
      wsUrl: "ws://nowhere.invalid",
      video: document.createElement("video"),
      prompt: "p",
      startImageDataUrl: "data:image/jpeg;base64,x",
      onStatus,
      onError,
    });
    expect(client.status).toBe("degraded_to_image");
    expect(onStatus).toHaveBeenCalledWith("degraded_to_image");
    expect(onError).toHaveBeenCalled();
    client.close(); // noop, must not throw
  });
});
