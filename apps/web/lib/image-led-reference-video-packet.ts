import { createHash } from "node:crypto";
import sharp from "sharp";
import { imageLedRouteIntent } from "./image-led-route-intent";
import type { ImageLedPoint } from "./image-led-walk";

/** Offline preparation only. This module has no provider, storage, database or HTTP client. */
export const REFERENCE_VIDEO_MODEL = "fal-ai/kling-video/o3/standard/reference-to-video";
export const REFERENCE_VIDEO_PARAMETERS = Object.freeze({ duration: "5" as const, shot_type: "customize" as const, generate_audio: false as const, aspect_ratio: "16:9" as const });
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown) => sha(JSON.stringify(value));
const isSha = (value: string) => /^[a-f0-9]{64}$/.test(value);
const fail = (message: string): never => { throw new RangeError(message); };

export interface ReferenceVideoImage {
  bytes: Buffer;
  sha256: string;
  content_type: "image/png" | "image/jpeg";
  width: number;
  height: number;
}
export interface ReferenceVideoLandmark {
  id: string;
  source_id: string;
  label: string;
  source_rectangle: { left: number; top: number; width: number; height: number };
  image: ReferenceVideoImage;
  /** Historical appearance text is deliberately excluded from provider conditioning. */
  visual?: string;
}
export interface ReferenceVideoContext {
  owner_route_id: string;
  owner_revision: number;
  source_binding_sha256: string;
  frame_review_sha256: string;
  still_manifest_sha256: string;
  six_frame_sha256: string[];
}
export interface ReferenceVideoPacketInput {
  context: ReferenceVideoContext;
  source: { sha256: string; width: number; height: number };
  points: ImageLedPoint[];
  from_index: number;
  endpoints: [ReferenceVideoImage & { checkpoint_index: number }, ReferenceVideoImage & { checkpoint_index: number }];
  landmarks: ReferenceVideoLandmark[];
}

async function exactImage(image: ReferenceVideoImage) {
  // Snapshot before the first await so a caller cannot mutate a Buffer during validation.
  const bytes = Buffer.from(image.bytes);
  if (!isSha(image.sha256) || sha(bytes) !== image.sha256 || !bytes.length || bytes.length > 12 * 1024 * 1024) fail("Image bytes differ from their immutable pin");
  const decoder = sharp(bytes, { failOn: "error", limitInputPixels: 16_777_216 });
  const meta = await decoder.metadata();
  const format = image.content_type === "image/png" ? "png" : image.content_type === "image/jpeg" ? "jpeg" : null;
  if (!format || meta.format !== format || (meta.pages ?? 1) !== 1 || (meta.orientation !== undefined && meta.orientation !== 1)
    || meta.width !== image.width || meta.height !== image.height || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 32 || image.height < 32 || image.width > 4096 || image.height > 4096) fail("Image encoding or dimensions differ from their pin");
  if (meta.hasAlpha) { const channels = (await sharp(bytes).stats()).channels; if (channels.at(-1)?.min !== 255) fail("Reference images must be opaque"); }
  return { pin: { sha256: image.sha256, bytes: bytes.length, content_type: image.content_type, width: image.width, height: image.height }, url: `data:${image.content_type};base64,${bytes.toString("base64")}` };
}

/** Builds exactly two original endpoints and four original source-crop references. Never submits. */
export async function buildReferenceLedVideoPacket(rawInput: ReferenceVideoPacketInput) {
  const input: ReferenceVideoPacketInput = { ...rawInput, context: structuredClone(rawInput.context), source: { ...rawInput.source },
    points: rawInput.points.map(p => ({ ...p })), endpoints: rawInput.endpoints.map(e => ({ ...e, bytes: Buffer.from(e.bytes) })) as ReferenceVideoPacketInput["endpoints"],
    landmarks: rawInput.landmarks.map(l => ({ ...l, source_rectangle: { ...l.source_rectangle }, image: { ...l.image, bytes: Buffer.from(l.image.bytes) } })) };
  const { context, source, from_index: index } = input;
  if (!context.owner_route_id || !Number.isSafeInteger(context.owner_revision) || context.owner_revision < 1
    || ![context.source_binding_sha256, context.frame_review_sha256, context.still_manifest_sha256, ...context.six_frame_sha256].every(isSha)
    || context.six_frame_sha256.length !== 6 || new Set(context.six_frame_sha256).size !== 6
    || input.points.length !== 6 || !Number.isInteger(index) || index < 0 || index > 4) fail("A complete frozen six-frame context is required");
  if (input.endpoints.length !== 2 || input.endpoints[0].checkpoint_index !== index || input.endpoints[1].checkpoint_index !== index + 1
    || input.endpoints[0].sha256 !== context.six_frame_sha256[index] || input.endpoints[1].sha256 !== context.six_frame_sha256[index + 1]
    || input.endpoints[0].width !== input.endpoints[1].width || input.endpoints[0].height !== input.endpoints[1].height) fail("Endpoints must be the exact adjacent frozen frames");
  if (input.landmarks.length !== 4 || new Set(input.landmarks.map(l => l.id)).size !== 4 || new Set(input.landmarks.map(l => l.source_id)).size !== 4
    || new Set(input.landmarks.map(l => l.image.sha256)).size !== 4
    || new Set(input.landmarks.map(l => l.label.normalize("NFKC").trim().toLowerCase())).size !== 4
    || input.landmarks.some(l => !l.id || !l.source_id || !l.label.trim() || l.label !== l.label.trim() || l.label.length > 80 || l.label.includes("@")
      || [...l.label].some(c => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127))) fail("Exactly four uniquely bound original building references are required");
  // Recompute all image-plane intent rather than accepting a caller's heading or a physical pose.
  const route_intent = imageLedRouteIntent({ source, points: input.points, landmarks: input.landmarks, checkpointIndex: index });
  if (input.landmarks.some(l => l.image.width !== l.source_rectangle.width || l.image.height !== l.source_rectangle.height)) fail("Whole-building crops must retain their original source-rectangle dimensions");
  const images = await Promise.all([...input.endpoints, ...input.landmarks.map(l => l.image)].map(exactImage));
  const [start, end] = images;
  const turn = route_intent.checkpoints[index + 1]!.turn_from_previous_degrees;
  const motion = Math.abs(turn) < 5 ? "continue forward along the existing lane" : `advance along the existing lane and gently turn ${turn < 0 ? "left" : "right"} toward the supplied end view`;
  const refs = input.landmarks.map((l, i) => `@Image${i + 1} is ${l.label}`).join("; ");
  const prompt = `One uninterrupted eye-level walking shot from the supplied first frame to the supplied last frame. ${motion}. Show continuous ground translation and consistent parallax, not a stationary zoom. ${refs}. These original crops govern the existing buildings' roof wings, bays, openings and roof-to-wall junctions; do not invent structures to display every reference. Keep buildings clipped or hidden when they are outside these endpoint views. Preserve the endpoint well, terraces, garden edges and fountain sculpture with natural occlusion. No new well, storefront, doorway or building; no architectural morph, scene reset, cut, dissolve or extra shot. Keep the end view faithful without a sudden snap. Route direction is qualitative source-image planning, not a calibrated physical camera.`;
  const body = { ...REFERENCE_VIDEO_PARAMETERS, prompt, start_image_url: start!.url, end_image_url: end!.url, image_urls: images.slice(2).map(i => i.url) };
  const input_pins = {
    context: structuredClone(context), source: { ...source }, route: { frame: "original-image-normalized" as const, points: input.points.map(p => ({ ...p })) }, route_intent,
    endpoints: input.endpoints.map((e, i) => ({ checkpoint_index: e.checkpoint_index, ...images[i]!.pin })),
    references: input.landmarks.map((l, i) => ({ reference: `@Image${i + 1}`, id: l.id, source_id: l.source_id, label: l.label, source_rectangle: { ...l.source_rectangle }, ...images[i + 2]!.pin })),
  };
  return {
    kind: "offline-reference-led-video-packet-v1" as const, authorization: "not-granted" as const, model: REFERENCE_VIDEO_MODEL,
    leg_id: `leg-p${index + 1}-p${index + 2}`, positions: [index + 1, index + 2], parameters: { ...REFERENCE_VIDEO_PARAMETERS }, body,
    body_sha256: hash(body), input_pins, input_binding_sha256: hash(input_pins), packet_sha256: hash({ model: REFERENCE_VIDEO_MODEL, body, input_pins }),
    estimate: { kind: "public-price-estimate-not-executable-quote" as const, rate_usd_per_second: 0.084, seconds: 5, estimated_usd: 0.42,
      pricing_url: "https://fal.ai/models/fal-ai/kling-video/o3/standard/reference-to-video", automatic_retries: 0 },
  };
}

/** A proposal only: no approval, reservation, ledger amendment or permission to submit. */
export function referenceLedVideoBudgetProposal(packets: Awaited<ReturnType<typeof buildReferenceLedVideoPacket>>[]) {
  const expected = ["leg-p1-p2", "leg-p2-p3", "leg-p3-p4", "leg-p4-p5", "leg-p5-p6"];
  const fields = ["aspect_ratio", "duration", "end_image_url", "generate_audio", "image_urls", "prompt", "shot_type", "start_image_url"];
  if (packets.length !== 5 || packets.some((p, i) => p.leg_id !== expected[i] || p.authorization !== "not-granted" || p.model !== REFERENCE_VIDEO_MODEL
    || hash(Object.keys(p.body).sort()) !== hash(fields) || Object.entries(REFERENCE_VIDEO_PARAMETERS).some(([key, value]) => p.body[key as keyof typeof p.body] !== value)
    || p.body_sha256 !== hash(p.body) || p.input_binding_sha256 !== hash(p.input_pins) || p.packet_sha256 !== hash({ model: p.model, body: p.body, input_pins: p.input_pins })
    || hash(p.input_pins.context) !== hash(packets[0]!.input_pins.context) || hash(p.input_pins.source) !== hash(packets[0]!.input_pins.source)
    || hash(p.input_pins.route) !== hash(packets[0]!.input_pins.route) || hash(p.input_pins.references) !== hash(packets[0]!.input_pins.references))) fail("Proposal must pin all five consistent immutable packets");
  return { kind: "reference-led-kling-o3-reservation-proposal-v1", authorization: "not-granted", model: REFERENCE_VIDEO_MODEL, parameters: { ...REFERENCE_VIDEO_PARAMETERS },
    owner_route_id: packets[0]!.input_pins.context.owner_route_id, context: structuredClone(packets[0]!.input_pins.context), source_sha256: packets[0]!.input_pins.source.sha256,
    current_cumulative_cap_usd: 8, historical_held_usd: 7.73,
    current_remaining_usd: 0.27, proposed_cumulative_cap_usd: 10, new_reservation_limit_usd: 2.1, worst_case_held_usd: 9.83,
    max_new_paid_submissions: 5, automatic_retries: 0, normal_motion_estimate_usd: 4.9, normal_motion_cap_usd: 5,
    pilot_first: "leg-p2-p3", remaining_submission_gate: "Both independent source-identity and route/temporal judges must pass the actual pilot footage before any other leg.",
    production_temporal_approval: "not-granted", legs: packets.map(p => ({ id: p.leg_id, positions: p.positions, packet_sha256: p.packet_sha256, body_sha256: p.body_sha256,
      input_binding_sha256: p.input_binding_sha256, estimated_usd: 0.42 })) };
}
