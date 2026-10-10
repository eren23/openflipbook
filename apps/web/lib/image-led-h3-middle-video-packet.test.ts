import { expect, it } from 'vitest';
import { buildH3MiddleVideoPacket, H3_MIDDLE_MODEL, H3_MIDDLE_PARAMETERS, type H3MiddlePacketInput } from './image-led-h3-middle-video-packet';
const fixture = (): H3MiddlePacketInput => ({ foundationSha256: 'a'.repeat(64), midpointBindingSha256: 'b'.repeat(64), endpointAssetsSha256: 'c'.repeat(64), midpointAssetsSha256: 'd'.repeat(64),
  start: { path: 'P2.png', sha256: '1'.repeat(64), bytes: 10 }, middle: { path: 'P2.5.png', sha256: '2'.repeat(64), bytes: 11 }, end: { path: 'P3.png', sha256: '3'.repeat(64), bytes: 12 },
  hosted: [{ role: 'checkpoint', checkpoint_index: 1, url: 'https://v3.fal.media/P2.png', sha256: '1'.repeat(64), bytes: 10, width: 1672, height: 941, content_type: 'image/png' },
    { role: 'midpoint', label: 'P2.5', url: 'https://v3.fal.media/P2.5.png', sha256: '2'.repeat(64), bytes: 11, width: 1672, height: 941, content_type: 'image/png' },
    { role: 'checkpoint', checkpoint_index: 2, url: 'https://v3.fal.media/P3.png', sha256: '3'.repeat(64), bytes: 12, width: 1672, height: 941, content_type: 'image/png' }] });
it('quotes exactly three native POV keyframes and one 2s interior constraint, no style/crop/video/audio references', () => {
  const input = fixture(), packet = buildH3MiddleVideoPacket(input);
  expect(packet.model).toBe(H3_MIDDLE_MODEL); expect(packet.parameters).toEqual(H3_MIDDLE_PARAMETERS);
  expect(Object.keys(packet.body).sort()).toEqual(['image_url', 'middle_image_url', 'end_image_url', 'middle_frame_time', 'duration', 'resolution', 'prompt_expansion_mode', 'enable_safety_checker', 'sync_mode', 'aspect_ratio', 'prompt'].sort());
  expect(packet.body).toMatchObject({ middle_frame_time: 2, duration: 4, resolution: '768P', prompt_expansion_mode: 'disabled', aspect_ratio: 'adaptive', enable_safety_checker: true, sync_mode: false });
  expect(packet.input_pins.middle.sha256).toBe(input.middle.sha256); input.middle.sha256 = 'f'.repeat(64); expect(packet.input_pins.middle.sha256).toBe('2'.repeat(64));
});
it('cannot substitute endpoint, foreign hosted bytes, wrong checkpoint, canvas or redirectable host', () => {
  for (const mode of ['duplicate', 'hash', 'size', 'role', 'canvas', 'host']) {
    const input = fixture();
    if (mode === 'duplicate') input.middle.sha256 = input.start.sha256;
    if (mode === 'hash') input.hosted[1].sha256 = 'e'.repeat(64);
    if (mode === 'size') input.hosted[1].bytes++;
    if (mode === 'role') input.hosted[2].checkpoint_index = 5;
    if (mode === 'canvas') input.hosted[1].height = 900;
    if (mode === 'host') input.hosted[1].url = 'https://v3.fal.media.evil.example/image';
    expect(() => buildH3MiddleVideoPacket(input), mode).toThrow();
  }
});
