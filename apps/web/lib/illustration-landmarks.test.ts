import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { prepareKeyframeMapReference, validateLandmarkReferences, sourceLandmarkReferences } from "./illustration-landmarks";
import { normalizeNanoKeyframe } from "./illustration-nano-output";
import type { Db } from "mongodb";

const labels = ["Bookshop", "Inn", "Forge", "Conservatory"];
const landmarks = labels.map((label, i) => ({ label, left: (i % 2) * 128, top: Math.floor(i / 2) * 64, width: 128, height: 64 }));
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
describe("map-bound building references", () => {
  it("retains full map pixels and binds each separately named source crop to exact original bytes", async () => {
    const raw = Buffer.alloc(256 * 128 * 3);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 256; x++) { const p = (y * 256 + x) * 3; raw[p] = x; raw[p + 1] = y; raw[p + 2] = x > 127 ? 200 : 30; }
    const original = await sharp(raw, { raw: { width: 256, height: 128, channels: 3 } }).png().toBuffer();
    const prepared = await prepareKeyframeMapReference(original, landmarks);
    expect(prepared.reference_preparation).toMatchObject({ version: "source-art-map-landmarks-v1", source_sha256: hash(original), source_width: 256, source_height: 128 });
    expect(prepared.landmark_labels).toEqual(labels);
    const full = Buffer.from(prepared.reference_url.split(",")[1]!, "base64");
    expect(prepared.reference_preparation.sha256).toBe(hash(full));
    expect(await sharp(full).removeAlpha().raw().toBuffer()).toEqual(raw);
    for (let i = 0; i < 4; i++) {
      const actual = Buffer.from(prepared.landmark_urls[i]!.split(",")[1]!, "base64");
      const expected = await sharp(original).extract(landmarks[i]!).removeAlpha().raw().toBuffer();
      expect(await sharp(actual).removeAlpha().raw().toBuffer()).toEqual(expected);
      expect(prepared.reference_preparation.landmarks?.[i]).toMatchObject({ ...landmarks[i], sha256: hash(actual) });
    }
  });
  it.each([
    [landmarks.slice(0, 3)],
    [[...landmarks.slice(0, 3), { ...landmarks[3], label: labels[0] }]],
    [[{ ...landmarks[0], label: "unowned house" }, ...landmarks.slice(1)]],
    [[{ ...landmarks[0], left: -1 }, ...landmarks.slice(1)]],
    [[{ ...landmarks[0], width: 257 }, ...landmarks.slice(1)]],
    [[{ ...landmarks[0], image_url: "https://unowned.example/image" }, ...landmarks.slice(1)]],
  ])("rejects missing, duplicate, unknown, out-of-bounds or supplied image references", input => {
    expect(() => validateLandmarkReferences(input, 256, 128, labels)).toThrow();
  });
  it("requires a reviewed record for this owner session and source hash", async () => {
    let query: unknown;
    const db = { collection: () => ({ findOne: async (q: unknown) => { query = q; return null; } }) } as unknown as Db;
    await expect(sourceLandmarkReferences(db, "owned", "place", "a".repeat(64), labels)).rejects.toThrow(/Review four/);
    expect(query).toEqual({ _id: `owned:place:${"a".repeat(64)}`, session_id: "owned", place_id: "place", source_sha256: "a".repeat(64) });
  });
});
describe("declared Nano frame conversion", () => {
  it("uniformly halves the compatible provider frame and retains both exact-byte hashes", async () => {
    const raw = await sharp({ create: { width: 1376, height: 768, channels: 3, background: "#286553" } }).png().toBuffer();
    const result = await normalizeNanoKeyframe(raw, { width: 688, height: 384 });
    expect(result.normalization).toMatchObject({ raw_sha256: hash(raw), output_sha256: hash(result.bytes), scale: .5, crop: false });
    expect(await sharp(result.bytes).metadata()).toMatchObject({ format: "jpeg", width: 688, height: 384 });
  });
  it.each([[1376, 736], [1344, 768], [688, 384]])("refuses incompatible provider %s×%s rather than cropping or stretching", async (width, height) => {
    const raw = await sharp({ create: { width, height, channels: 3, background: "#286553" } }).png().toBuffer();
    await expect(normalizeNanoKeyframe(raw, { width: 688, height: 384 })).rejects.toThrow(/incompatible/);
  });
  it("refuses an exact-size PNG whose EXIF changes its orientation", async () => {
    const raw = await sharp({ create: { width: 1376, height: 768, channels: 3, background: "#286553" } }).withMetadata({ orientation: 6 }).png().toBuffer();
    expect((await sharp(raw).metadata()).orientation).toBe(6);
    await expect(normalizeNanoKeyframe(raw, { width: 688, height: 384 })).rejects.toThrow(/incompatible/);
  });
  it("refuses the old 8:3 saved camera", async () => {
    await expect(normalizeNanoKeyframe(Buffer.alloc(0), { width: 1024, height: 384 })).rejects.toThrow(/compatible/);
  });
});
