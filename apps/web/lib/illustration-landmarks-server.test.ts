import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
const memory = vi.hoisted(() => ({ owner: true, source: Buffer.alloc(0) as Buffer, record: null as unknown, writes: [] as unknown[] }));
vi.mock("./creator", () => ({ requireCreator: vi.fn(async () => { if (!memory.owner) throw new Error("Not owned"); }) }));
vi.mock("./r2", () => ({ getStoredBytes: vi.fn(async () => ({ bytes: memory.source })) }));
vi.mock("./db", () => ({ getDb: async () => ({ collection: (name: string) => ({
  findOne: async () => name === "place_scenes" ? { source_image_key: "owned-map", definition: { objects: ["Bookshop", "Inn", "Forge", "Conservatory"].map(label => ({ label, kind: "building" })) } } : memory.record,
  updateOne: async (filter: unknown, update: unknown, options: unknown) => { memory.writes.push({ filter, update, options }); },
}) }) }));
import { landmarkReferenceAction } from "./illustration-landmarks-server";
import { getStoredBytes } from "./r2";
const landmarks = ["Bookshop", "Inn", "Forge", "Conservatory"].map((label, i) => ({ label, left: (i % 2) * 128, top: Math.floor(i / 2) * 64, width: 128, height: 64 }));
beforeEach(async () => { vi.clearAllMocks(); memory.owner = true; memory.record = null; memory.writes = []; memory.source = await sharp({ create: { width: 256, height: 128, channels: 3, background: "#286553" } }).jpeg().toBuffer(); });
it("rejects a non-owner before reading private source artwork", async () => {
  memory.owner = false;
  await expect(landmarkReferenceAction("world", "place")).rejects.toThrow("Not owned");
  expect(getStoredBytes).not.toHaveBeenCalled(); expect(memory.writes).toHaveLength(0);
});
it("fences source changes and unreviewed requests before storing crop metadata", async () => {
  await expect(landmarkReferenceAction("world", "place", { source_sha256: "0".repeat(64), reviewed: true, landmarks })).rejects.toThrow(/exact original/);
  const sha = createHash("sha256").update(memory.source).digest("hex");
  await expect(landmarkReferenceAction("world", "place", { source_sha256: sha, landmarks })).rejects.toThrow(/Review/);
  expect(memory.writes).toHaveLength(0);
});
it("stores only reviewed source-bound rectangles and keeps canonical scene and source bytes intact", async () => {
  const sha = createHash("sha256").update(memory.source).digest("hex");
  const result = await landmarkReferenceAction("world", "place", { source_sha256: sha, reviewed: true, landmarks });
  expect(result).toMatchObject({ source_sha256: sha, source_width: 256, source_height: 128, landmarks });
  expect(memory.writes).toHaveLength(1);
  expect(memory.writes[0]).toMatchObject({ filter: { _id: `world:place:${sha}` }, update: { $set: { session_id: "world", source_sha256: sha, landmarks } } });
});
