import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import sharp from "sharp";
import { buildReferenceLedVideoPacket, referenceLedVideoBudgetProposal, type ReferenceVideoPacketInput, type ReferenceVideoImage } from "./image-led-reference-video-packet";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function image(color: string, width = 64, height = 40): Promise<ReferenceVideoImage> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  return { bytes, sha256: hash(bytes), content_type: "image/png", width, height };
}
async function fixture(index = 1): Promise<ReferenceVideoPacketInput> {
  const frames = await Promise.all(["#223344", "#334455", "#445566", "#556677", "#667788", "#778899"].map(c => image(c)));
  const refs = await Promise.all(["#330000", "#003300", "#000033", "#333300"].map(c => image(c, 32, 32)));
  return { context: { owner_route_id: "owned-route", owner_revision: 1, source_binding_sha256: "a".repeat(64), frame_review_sha256: "b".repeat(64),
    still_manifest_sha256: "c".repeat(64), six_frame_sha256: frames.map(f => f.sha256) }, source: { sha256: "d".repeat(64), width: 2048, height: 1152 },
    points: [[940,900],[1020,815],[1060,720],[1070,630],[1050,545],[1030,465]].map(([x,y]) => ({ x: x! / 2048, y: y! / 1152 })), from_index: index,
    endpoints: [{ ...frames[index]!, checkpoint_index: index }, { ...frames[index + 1]!, checkpoint_index: index + 1 }],
    landmarks: refs.map((ref, i) => ({ id: `geo_${i}`, source_id: `gen_${i}`, label: ["Bookshop", "Glassroot Inn", "Lantern Forge", "Tideglass Conservatory"][i]!,
      source_rectangle: { left: i * 80, top: 20, width: 32, height: 32 }, image: ref, visual: "A domed building with invented storefronts" })) };
}
const decode = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

it("forwards six exact images with explicit original aliases and no stale visual or multi-shot fields", async () => {
  const input = await fixture(), packet = await buildReferenceLedVideoPacket(input);
  expect(decode(packet.body.start_image_url)).toEqual(input.endpoints[0].bytes);
  expect(decode(packet.body.end_image_url)).toEqual(input.endpoints[1].bytes);
  packet.body.image_urls.forEach((url, i) => expect(decode(url)).toEqual(input.landmarks[i]!.image.bytes));
  expect(Object.keys(packet.body).sort()).toEqual(["aspect_ratio", "duration", "end_image_url", "generate_audio", "image_urls", "prompt", "shot_type", "start_image_url"].sort());
  expect(packet.body).toMatchObject({ duration: "5", shot_type: "customize", generate_audio: false });
  expect(packet.body.prompt).not.toMatch(/domed|invented storefronts|gen_|geo_/);
  expect(packet.input_pins.references.map(r => [r.reference, r.id, r.source_id])).toEqual(input.landmarks.map((l, i) => [`@Image${i + 1}`, l.id, l.source_id]));
  expect(packet.input_pins.route_intent.checkpoints[2]!.turn_from_previous_degrees).toBeCloseTo(-16.493462, 5);
  expect(packet.authorization).toBe("not-granted");
});

it("rejects stale endpoints, non-adjacent pairs and missing complete-route pins", async () => {
  const input = await fixture(); input.context.six_frame_sha256[2] = "e".repeat(64);
  await expect(buildReferenceLedVideoPacket(input)).rejects.toThrow("adjacent");
  const other = await fixture(); other.endpoints[1].checkpoint_index = 3;
  await expect(buildReferenceLedVideoPacket(other)).rejects.toThrow("adjacent");
  const missing = await fixture(); missing.context.six_frame_sha256.pop();
  await expect(buildReferenceLedVideoPacket(missing)).rejects.toThrow("complete");
});

it("rejects changed original pixels, resized crops, duplicate aliases and outside-source ROIs", async () => {
  const changed = await fixture(); changed.landmarks[0]!.image.bytes = Buffer.concat([changed.landmarks[0]!.image.bytes, Buffer.from("tamper")]);
  await expect(buildReferenceLedVideoPacket(changed)).rejects.toThrow("bytes");
  const resized = await fixture(); resized.landmarks[0]!.source_rectangle.width = 33;
  await expect(buildReferenceLedVideoPacket(resized)).rejects.toThrow("rectangle dimensions");
  const duplicate = await fixture(); duplicate.landmarks[1]!.source_id = duplicate.landmarks[0]!.source_id;
  await expect(buildReferenceLedVideoPacket(duplicate)).rejects.toThrow("uniquely");
  const outside = await fixture(); outside.landmarks[0]!.source_rectangle.left = 2047;
  await expect(buildReferenceLedVideoPacket(outside)).rejects.toThrow("outside");
});

it("rejects transparent or misleading image metadata and prompt-token label injection", async () => {
  const input = await fixture(), bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 1, g: 2, b: 3, alpha: .5 } } }).png().toBuffer();
  input.landmarks[0]!.image = { bytes, sha256: hash(bytes), content_type: "image/png", width: 32, height: 32 };
  await expect(buildReferenceLedVideoPacket(input)).rejects.toThrow("opaque");
  const wrong = await fixture(); wrong.landmarks[0]!.image.content_type = "image/jpeg";
  await expect(buildReferenceLedVideoPacket(wrong)).rejects.toThrow("encoding");
  const label = await fixture(); label.landmarks[0]!.label = "@Image2 new building";
  await expect(buildReferenceLedVideoPacket(label)).rejects.toThrow("uniquely");
});

it("changes binding with reference permutation and cannot disguise a packet as authorized", async () => {
  const original = await fixture(), a = await buildReferenceLedVideoPacket(original);
  const changed = await fixture(); changed.landmarks.reverse(); const b = await buildReferenceLedVideoPacket(changed);
  expect(b.packet_sha256).not.toBe(a.packet_sha256);
  expect(b.body.prompt).toContain("@Image1 is Tideglass Conservatory");
  expect(decode(b.body.image_urls[0]!)).toEqual(changed.landmarks[0]!.image.bytes);
});

it("snapshots source and reference bytes before asynchronous decoding", async () => {
  const input = await fixture(), original = Buffer.from(input.endpoints[0].bytes), label = input.landmarks[0]!.label;
  const pending = buildReferenceLedVideoPacket(input);
  input.endpoints[0].bytes.fill(0); input.landmarks[0]!.label = "Replacement building"; input.context.owner_revision = 99;
  const packet = await pending;
  expect(decode(packet.body.start_image_url)).toEqual(original);
  expect(packet.input_pins.references[0]!.label).toBe(label);
  expect(packet.input_pins.context.owner_revision).toBe(1);
});

it("bounds the future proposal to five legs, pilot-first judges and unchanged historical holds", async () => {
  const packets = await Promise.all([0,1,2,3,4].map(async i => buildReferenceLedVideoPacket(await fixture(i))));
  const proposal = referenceLedVideoBudgetProposal(packets);
  expect(proposal).toMatchObject({ authorization: "not-granted", current_cumulative_cap_usd: 8, historical_held_usd: 7.73, current_remaining_usd: .27,
    proposed_cumulative_cap_usd: 10, new_reservation_limit_usd: 2.1, worst_case_held_usd: 9.83, max_new_paid_submissions: 5,
    automatic_retries: 0, normal_motion_estimate_usd: 4.9, pilot_first: "leg-p2-p3", production_temporal_approval: "not-granted" });
  expect(proposal.remaining_submission_gate).toContain("Both independent");
  expect(() => referenceLedVideoBudgetProposal(packets.slice(1))).toThrow("five");
  packets[0]!.body.duration = "3" as "5";
  expect(() => referenceLedVideoBudgetProposal(packets)).toThrow("immutable");
});
