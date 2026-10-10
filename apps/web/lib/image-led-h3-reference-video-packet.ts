import { createHash } from "node:crypto";
import { buildReferenceLedVideoPacket, type ReferenceVideoPacketInput } from "./image-led-reference-video-packet";

/** Offline only. Original whole-building pixels, not historical appearance prose, condition the model. */
export const H3_REFERENCE_MODEL = "minimax/h3-max/reference-to-video";
export const H3_REFERENCE_PARAMETERS = Object.freeze({ duration: 4, resolution: "768P" as const,
  prompt_expansion_mode: "disabled" as const, aspect_ratio: "adaptive" as const,
  enable_safety_checker: true, sync_mode: false });
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export async function buildH3ReferenceVideoPacket(input: ReferenceVideoPacketInput) {
  // The reused decoder checks exact frozen bytes, opaque/upright encodings, crop dimensions,
  // all six approved inputs and actual source-image route. Its old body is never submitted.
  const checked = await buildReferenceLedVideoPacket(input);
  const index = checked.positions[0]! - 1;
  const turn = checked.input_pins.route_intent.checkpoints[index + 1]!.turn_from_previous_degrees;
  const motion = Math.abs(turn) < 5 ? "Walk forward along the existing lane" : `Walk forward along the existing lane, turning gently ${turn < 0 ? "left" : "right"} toward the ending view`;
  const references = checked.input_pins.references.map((r, i) => ({ ...r, reference: `Image ${i + 1}` }));
  const labels = references.map(r => `${r.reference}: ${r.label}`).join("; ");
  const localContext = index === 1
    ? " Stay in the cobbled passage below the Inn's raised terrace on the left and the Conservatory's garden steps on the right. The one roofed well at the right edge becomes increasingly clipped. Keep one fountain ahead and remain before its pool; let its position change naturally."
    : " Keep the terrace boundaries, garden edges, single well and fountain consistent where visible; allow natural clipping as the lane bends. Remain before the fountain pool.";
  const prompt = `One uninterrupted first-person eye-level walk, starting on the supplied opening frame and ending on the supplied closing frame. ${motion}, with continuous ground translation and natural parallax.${localContext} ${labels}. These reference images govern existing architectural details, not camera viewpoints. Preserve the same roof wings, bays, openings and roof-to-wall junctions. Leave behind-camera buildings outside the frame. No duplicate landmarks, new structures, morphing architecture, stationary zoom, cuts, dissolves, scene reset or sudden snap to the ending frame. Keep the illustrated style and lighting.`;
  const body = { ...H3_REFERENCE_PARAMETERS, prompt, image_url: checked.body.start_image_url,
    end_image_url: checked.body.end_image_url, reference_image_urls: [...checked.body.image_urls] };
  for (const image of [...checked.input_pins.endpoints, ...references]) {
    if (image.width < 300 || image.height < 300 || image.width / image.height < .4 || image.width / image.height > 2.5)
      throw new RangeError("H3 references must satisfy the documented minimum dimensions and aspect bounds");
  }
  if (prompt.length > 1800) throw new RangeError("Walking conditioning must stay short");
  const input_pins = { ...checked.input_pins, references, conditioning: "exact-adjacent-endpoints-and-four-original-crops" as const };
  const imageTokens = [...input_pins.endpoints, ...references].reduce((n, i) => n + i.width * i.height / 1024, 0);
  const surcharge = Math.ceil(Math.max(0, imageTokens - 4096) / 1000) * .02;
  // Reserve one extra second beyond the request; docs describe approximately .7s possible overrun.
  const estimate = { output_rate_usd_per_second: .08, requested_seconds: 4, output_buffer_seconds: 1,
    conservative_all_six_image_tokens: imageTokens, included_reference_tokens: 4096, reference_surcharge_usd: surcharge,
    conservative_estimated_usd: Number((5 * .08 + surcharge).toFixed(2)), reservation_usd: .42,
    pricing_url: "https://fal.ai/models/minimax/h3-max/reference-to-video", automatic_retries: 0,
    billing_limit: "Reservation estimate, not a contractual provider output-duration guarantee." };
  if (estimate.conservative_estimated_usd > estimate.reservation_usd) throw new RangeError("Original references exceed the closed pilot reservation");
  return { kind: "offline-h3-reference-video-packet-v1" as const, authorization: "not-granted" as const,
    model: H3_REFERENCE_MODEL, leg_id: checked.leg_id, positions: [...checked.positions], parameters: { ...H3_REFERENCE_PARAMETERS }, body,
    body_sha256: hash(body), input_pins, input_binding_sha256: hash(input_pins),
    packet_sha256: hash({ model: H3_REFERENCE_MODEL, body, input_pins }), estimate };
}
