import { afterEach, expect, it, vi } from "vitest";
const readFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile, default: { readFile } }));
import { GET } from "@/app/api/dev/spatial-assets/[file]/route";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const request = (file: string) => GET(new Request("http://localhost/api/dev/spatial-assets/" + file), { params: Promise.resolve({ file }) });

it("never serves study artifacts in production or with the flag off", async () => {
  vi.stubEnv("SPATIAL_STUDY", "1"); vi.stubEnv("NODE_ENV", "production");
  expect((await request("controlled-summary.json")).status).toBe(404);
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("SPATIAL_STUDY", "0");
  expect((await request("controlled-reference.mp4")).status).toBe(404);
  expect(readFile).not.toHaveBeenCalled();
});

it("serves JSON uncached and rejects paths outside the allowlist", async () => {
  vi.stubEnv("SPATIAL_STUDY", "1"); vi.stubEnv("NODE_ENV", "development");
  readFile.mockResolvedValue(Buffer.from("{}"));
  const response = await request("controlled-summary.json");
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await request("controlled-first.png")).headers.get("Content-Type")).toBe("image/png");
  expect((await request("../.env")).status).toBe(404);
  expect(readFile).toHaveBeenCalledTimes(2);
  readFile.mockRejectedValue(new Error("missing"));
  expect((await request("controlled-fast-101.mp4")).status).toBe(404);
});

it.each([
  ["bytes=0-2", 206, "012", "bytes 0-2/10"],
  ["bytes=7-", 206, "789", "bytes 7-9/10"],
  ["bytes=-2", 206, "89", "bytes 8-9/10"],
  ["bytes=0-99", 206, "0123456789", "bytes 0-9/10"],
  ["bytes=10-", 416, "", "bytes */10"],
  ["bytes=4-2", 416, "", "bytes */10"],
  ["bytes=-0", 416, "", "bytes */10"],
  ["bytes=-", 416, "", "bytes */10"],
  ["bytes=0-2,4-6", 416, "", "bytes */10"],
  ["bad", 416, "", "bytes */10"],
])("serves seekable media for %s", async (range, status, body, contentRange) => {
  vi.stubEnv("SPATIAL_STUDY", "1"); vi.stubEnv("NODE_ENV", "development");
  readFile.mockResolvedValue(Buffer.from("0123456789"));
  const response = await GET(new Request("http://localhost/clip", { headers: { Range: range } }), { params: Promise.resolve({ file: "controlled-reference.mp4" }) });
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Range")).toBe(contentRange);
  expect(await response.text()).toBe(body);
});
