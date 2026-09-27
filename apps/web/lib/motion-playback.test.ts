// @vitest-environment node
import { expect, it } from "vitest";
import { motionPlaybackResponse } from "./motion-playback";
const bytes = new TextEncoder().encode("0123456789");
const request = (range?: string, extra: Record<string, string> = {}) => new Request("http://localhost/clip", { headers: { ...(range ? { range } : {}), ...extra } });
it.each([["bytes=0-1", "01", "bytes 0-1/10"], ["bytes=7-", "789", "bytes 7-9/10"], ["bytes=-2", "89", "bytes 8-9/10"],
  ["bytes=8-9999999999999999999999999999", "89", "bytes 8-9/10"], ["bytes=-9999999999999999999999999999", "0123456789", "bytes 0-9/10"]])("serves the exact private range %s", async (range, text, contentRange) => {
  const response = motionPlaybackResponse(request(range), bytes);
  expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe(contentRange);
  expect(response.headers.get("content-length")).toBe(String(text!.length)); expect(await response.text()).toBe(text);
  expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
});
it.each(["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=1.5-2", "bytes=9999999999999999999999999999-", `bytes=${"9".repeat(300)}-`])("rejects unsatisfiable range %s", async range => {
  const response = motionPlaybackResponse(request(range), bytes); expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */10"); expect(await response.text()).toBe("");
});
it.each([undefined, "items=0-1", "bytes=0-1,5-6"])("returns a full response for unsupported range %s", async range => {
  const response = motionPlaybackResponse(request(range), bytes); expect(response.status).toBe(200);
  expect(response.headers.get("accept-ranges")).toBe("bytes"); expect(await response.text()).toBe("0123456789");
});
it("ignores If-Range without claiming validator agreement", async () => {
  const response = motionPlaybackResponse(request("bytes=0-1", { "if-range": '"unknown"' }), bytes);
  expect(response.status).toBe(200); expect(await response.text()).toBe("0123456789");
});
