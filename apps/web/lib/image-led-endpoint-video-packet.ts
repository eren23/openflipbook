import { createHash } from "node:crypto";
import { buildReferenceLedVideoPacket, type ReferenceVideoPacketInput } from "./image-led-reference-video-packet";
import { KLING_ENDPOINT_VIDEO_MODEL, validateKlingEndpointVideoCapability } from "./image-led-kling-video-capability";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Offline replacement proposal. Exact original references remain judging evidence, not provider inputs. */
export async function buildEndpointLedVideoPacket(input: ReferenceVideoPacketInput, duration: "4" | "5" = "4") {
  // Reuse immutable image decoding, source crop dimensions, adjacent frame and full-route checks.
  // This old builder never calls a provider; its unsupported body is discarded completely.
  const validated = await buildReferenceLedVideoPacket(input);
  const index = validated.positions[0]! - 1;
  const turn = validated.input_pins.route_intent.checkpoints[index + 1]!.turn_from_previous_degrees;
  const motion = Math.abs(turn) < 5 ? "Continue forward along the existing lane" : `Advance along the existing lane and turn gently ${turn < 0 ? "left" : "right"} toward the supplied end view`;
  const prompt = `One continuous first-person eye-level walking shot from the supplied first frame to the supplied last frame. ${motion}. Move the viewpoint forward over the ground with consistent parallax and a subtle walking rhythm. Keep the same lane, building silhouettes, roof wings, windows, terrace boundaries and garden edges throughout. Preserve the existing well and fountain where visible; let them move and become clipped naturally. Keep hidden buildings outside the frame. No additional architecture or duplicate landmarks. No cut, scene change, dissolve, stationary zoom, architectural morph or sudden endpoint snap.`;
  const body = { prompt, image_url: validated.body.start_image_url, end_image_url: validated.body.end_image_url,
    duration, generate_audio: false as const, shot_type: "customize" as const };
  validateKlingEndpointVideoCapability({ model: KLING_ENDPOINT_VIDEO_MODEL, body,
    start: validated.input_pins.endpoints[0]!, end: validated.input_pins.endpoints[1]! });
  const { references, ...routePins } = validated.input_pins;
  const input_pins = { ...routePins, provider_conditioning: "two-exact-approved-endpoints-only" as const,
    judge_only_original_references: references.map(r => ({ id: r.id, source_id: r.source_id, label: r.label,
      source_rectangle: r.source_rectangle, sha256: r.sha256, bytes: r.bytes, content_type: r.content_type, width: r.width, height: r.height })),
    original_reference_pixels_forwarded_to_provider: false as const };
  return { kind: "offline-endpoint-led-video-packet-v1" as const, authorization: "not-granted" as const,
    model: KLING_ENDPOINT_VIDEO_MODEL, leg_id: validated.leg_id, positions: [...validated.positions], body,
    body_sha256: hash(body), input_pins, input_binding_sha256: hash(input_pins),
    packet_sha256: hash({ model: KLING_ENDPOINT_VIDEO_MODEL, body, input_pins }),
    estimate: { kind: "public-price-estimate-not-executable-quote" as const, seconds: Number(duration), rate_usd_per_second: .084,
      estimated_usd: Number((Number(duration) * .084).toFixed(3)), reservation_usd: Math.ceil(Number(duration) * 8.4) / 100,
      pricing_url: "https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video", automatic_retries: 0 },
    evidence_limit: "Documented input combination; acceptance, building identity and continuous walking remain unmeasured until actual footage passes both independent judges." };
}
