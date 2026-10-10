// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { send = state.send; }, GetObjectCommand: class { constructor(public input: unknown) {} }, PutObjectCommand: class { constructor(public input: unknown) {} } }));
vi.mock("./stored-image-access", () => ({ requireStoredImageRead: state.read }));
import { inlineStoredImage, uploadJpeg } from "./r2";
beforeEach(() => {
  vi.stubEnv("R2_ENDPOINT", "http://test-storage"); vi.stubEnv("R2_ACCESS_KEY_ID", "test"); vi.stubEnv("R2_SECRET_ACCESS_KEY", "test"); vi.stubEnv("R2_BUCKET", "test"); vi.stubEnv("R2_PUBLIC_BASE_URL", "/api/blobs");
  state.read.mockReset().mockResolvedValue(undefined); state.send.mockReset().mockResolvedValue({ ContentType: "image/png", Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
});
afterEach(() => vi.unstubAllEnvs());
it("checks ownership before inlining protected stored image bytes into provider input", async () => {
  expect(await inlineStoredImage("/api/blobs/world/image.png")).toBe("data:image/png;base64,AQID"); expect(state.read).toHaveBeenCalledWith("world/image.png");
  state.read.mockRejectedValue(new Error("Not owner")); state.send.mockClear();
  expect(await inlineStoredImage("/api/blobs/private/image.png")).toBeNull(); expect(state.send).not.toHaveBeenCalled();
});
it("does not read foreign URLs and stores private cache directives on new blobs", async () => {
  expect(await inlineStoredImage("https://foreign.test/image.png")).toBeNull(); expect(state.read).not.toHaveBeenCalled();
  const uploaded = await uploadJpeg("world/image.png", Buffer.from([1]), "image/png");
  expect(uploaded.url).toBe("/api/blobs/world/image.png"); expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ CacheControl: "private, no-store" }) }), undefined);
});
