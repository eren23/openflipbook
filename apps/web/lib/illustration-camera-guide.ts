import sharp from "sharp";
import { createHash } from "node:crypto";
import { CreatorError } from "./creator-error";
import { registeredPixels } from "./illustration-region";
import type { KeyframePasses } from "./illustration-keyframe";
import type { ViewSource, SourceArtworkLandmark, KeyframeStructuralGuideProof } from "./place-view";

/** Read-only annotations of actual saved mask pixels; no projected or invented geometry. */
export async function prepareKeyframeCameraGuides(passes: KeyframePasses, sources: ViewSource[], landmarks: SourceArtworkLandmark[], mode: "saved-camera-guides-v1" | "saved-camera-controlnet-v1" = "saved-camera-guides-v1") {
  const { view } = passes, width = view.width, height = view.height;
  if (width !== 688 || height !== 384) throw new CreatorError("Camera guides require the registered 688 × 384 saved view", 409);
  const mask = await registeredPixels(passes.objects, width, height, true);
  const rendered = await registeredPixels(passes.render, width, height, true);
  await registeredPixels(passes.depth, width, height, true);
  const bindings = landmarks.map((l, index) => {
    const found = sources.flatMap(s => s.definition.objects).filter(o => o.label === l.label && ["building", "house", "tavern"].includes(o.kind));
    const object = found.length === 1 ? view.objects.find(o => o.object_id === found[0]!.id) : undefined;
    if (!object) throw new CreatorError("A named building is missing or ambiguous in this saved camera", 409);
    return { index: index + 1, label: l.label, object_id: object.object_id, rgb: object.rgb, pixels: 0, x: 0, y: 0 };
  });
  if (bindings.length !== 4 || new Set(bindings.map(b => b.object_id)).size !== 4) throw new CreatorError("Four distinct camera landmark identities are required", 409);
  const ids = new Int8Array(width * height).fill(-1);
  for (let p = 0; p < ids.length; p++) {
    const b = bindings.find(b => mask[p * 4] === b.rgb[0] && mask[p * 4 + 1] === b.rgb[1] && mask[p * 4 + 2] === b.rgb[2] && mask[p * 4 + 3] === 255);
    if (b) { ids[p] = b.index - 1; b.pixels++; b.x += p % width; b.y += Math.floor(p / width); }
  }
  if (bindings.some(b => b.pixels < 4)) throw new CreatorError("Every named landmark must be visible in the saved camera guide", 409);
  const overlay = Buffer.alloc(width * height * 4);
  for (let p = 0; p < ids.length; p++) {
    if (ids[p]! < 0) continue;
    const x = p % width, y = Math.floor(p / width), id = ids[p];
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || ids[p - 1] !== id || ids[p + 1] !== id || ids[p - width] !== id || ids[p + width] !== id)
      overlay.set([255, 235, 20, 255], p * 4);
  }
  const tags = bindings.map(b => `<g><circle cx="${Math.round(b.x / b.pixels)}" cy="${Math.round(b.y / b.pixels)}" r="9" fill="white" stroke="black"/><text x="${Math.round(b.x / b.pixels)}" y="${Math.round(b.y / b.pixels) + 4}" font-family="sans-serif" font-size="12" font-weight="bold" text-anchor="middle" fill="black">${b.index}</text></g>`).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${tags}</svg>`);
  let outline: Buffer | undefined;
  if (mode === "saved-camera-controlnet-v1") {
    const edges = Buffer.alloc(width * height * 3);
    for (let p = 0; p < ids.length; p++) {
      const x = p % width, y = Math.floor(p / width);
      // Actual mask silhouette edges plus visible render discontinuities such
      // as door/window borders. No badges, text, projected boxes or reference art.
      const neighbours = [x ? p - 1 : p, x < width - 1 ? p + 1 : p, y ? p - width : p, y < height - 1 ? p + width : p];
      const edge = neighbours.some(q => ids[p] !== ids[q] || [0,1,2].some(c => Math.abs(rendered[p * 4 + c]! - rendered[q * 4 + c]!) >= 32));
      if (edge) edges.fill(255, p * 3, p * 3 + 3);
    }
    outline = await sharp(edges, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }
  const guide = await sharp(passes.render).composite([{ input: overlay, raw: { width, height, channels: 4 } }, { input: svg }]).png().toBuffer();
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const proof: KeyframeStructuralGuideProof = { version: mode, width: 688, height: 384, guide_sha256: hash(guide),
    render_sha256: hash(passes.render), objects_sha256: hash(passes.objects), depth_sha256: hash(passes.depth), ...(outline ? { outline_sha256: hash(outline) } : {}),
    landmarks: bindings.map(b => ({ index: b.index, label: b.label, object_id: b.object_id, visible_pixels: b.pixels })) };
  return { structural_guide_url: `data:image/png;base64,${guide.toString("base64")}`, depth_guide_url: `data:image/png;base64,${passes.depth.toString("base64")}`, ...(outline ? { outline_guide_url: `data:image/png;base64,${outline.toString("base64")}` } : {}), proof };
}
