import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const H3_MIDDLE_MODEL = 'minimax/h3-max/reference-to-video';
export const H3_MIDDLE_PARAMETERS = Object.freeze({ duration: 4, resolution: '768P', middle_frame_time: 2,
  prompt_expansion_mode: 'disabled', enable_safety_checker: true, sync_mode: false, aspect_ratio: 'adaptive' });
export const H3_MIDDLE_PROMPT = 'One uninterrupted eye-level forward walking shot through this same cobbled lane. '
  + 'Begin at the exact first image, naturally pass through the exact middle image at two seconds, and attain the exact final image at four seconds. '
  + 'Make a subtle leftward reorientation with differential parallax from translation. Keep the Inn curved terrace on the left and the Conservatory garden on the right. '
  + 'The single well moves outside the right edge; keep the one two-dish clustered-leaf fountain off center ahead, with its low stepped pool. '
  + 'Keep every visible roof, lantern, window, doorway, terrace, sculpture and person rigid and consistent with the three supplied views. '
  + 'Keep continuous lighting and exposure. No cuts, dissolves, crossfade, scene blending, double edges, teleporting, redesign, duplicated architecture, digital zoom or orbit. '
  + 'The middle image is an intermediate position, not a new scene or destination arrival.';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface H3MiddleImagePin { path: string; sha256: string; bytes: number; width?: number; height?: number; }
export interface H3MiddleHostedImage { role: 'checkpoint' | 'midpoint'; checkpoint_index?: number; label?: 'P2.5';
  url: string; sha256: string; bytes: number; width: number; height: number; content_type: 'image/png'; }
export interface H3MiddlePacketInput { foundationSha256: string; midpointBindingSha256: string; endpointAssetsSha256: string;
  midpointAssetsSha256: string; start: H3MiddleImagePin; middle: H3MiddleImagePin; end: H3MiddleImagePin;
  hosted: [H3MiddleHostedImage, H3MiddleHostedImage, H3MiddleHostedImage]; }
export function buildH3MiddleVideoPacket(input: H3MiddlePacketInput) {
  const pins = { start: structuredClone(input.start), middle: structuredClone(input.middle), end: structuredClone(input.end) };
  for (const sha of [input.foundationSha256, input.midpointBindingSha256, input.endpointAssetsSha256, input.midpointAssetsSha256]) assert(/^[a-f0-9]{64}$/.test(sha));
  assert.equal(new Set(Object.values(pins).map(p => p.sha256)).size, 3, 'Three distinct actual POV views are required');
  for (const [i, image] of input.hosted.entries()) {
    const pin = Object.values(pins)[i]!;
    assert(/^[a-f0-9]{64}$/.test(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= 12 * 1024 * 1024);
    assert(image.sha256 === pin.sha256 && image.bytes === pin.bytes && image.content_type === 'image/png');
    assert(Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height) && image.width >= 32 && image.height >= 32 && image.width <= 4096 && image.height <= 4096);
    assert(!pin.width || pin.width === image.width); assert(!pin.height || pin.height === image.height);
    assert(i === 1 ? image.role === 'midpoint' && image.label === 'P2.5' : image.role === 'checkpoint' && image.checkpoint_index === (i === 0 ? 1 : 2));
    const url = new URL(image.url);
    assert(url.protocol === 'https:' && (url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media')) && !url.search && !url.hash && !url.username && !url.password);
  }
  assert(input.hosted.every(image => image.width === input.hosted[0].width && image.height === input.hosted[0].height), 'Exact native three-view canvas must agree');
  const body = { image_url: input.hosted[0].url, middle_image_url: input.hosted[1].url, end_image_url: input.hosted[2].url,
    middle_frame_time: 2, duration: 4, resolution: '768P', prompt_expansion_mode: 'disabled', enable_safety_checker: true,
    sync_mode: false, aspect_ratio: 'adaptive', prompt: H3_MIDDLE_PROMPT };
  const binding = { model: H3_MIDDLE_MODEL, body, input_pins: pins, foundation_sha256: input.foundationSha256,
    midpoint_binding_sha256: input.midpointBindingSha256, endpoint_assets_sha256: input.endpointAssetsSha256, midpoint_assets_sha256: input.midpointAssetsSha256 };
  return { kind: 'offline-h3-middle-keyframe-video-packet-v1', leg_id: 'leg-p2-p3', positions: [2, 3], ...binding,
    parameters: H3_MIDDLE_PARAMETERS, body_sha256: hash(body), input_binding_sha256: hash(pins), packet_sha256: hash(binding),
    diagnostic: true, production_sequence: false, owner_temporal_approved: false };
}
