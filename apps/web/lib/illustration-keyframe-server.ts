/**
 * Keyframe painting on one capture: the render, depth and object passes of a
 * saved view or of one motion-study frame, with that frame's camera. Nothing
 * here reads a view id, a job or storage, so path videos reuse it.
 * prepare -> one paid submit (caller) -> gate request (caller) -> finish.
 */
import sharp from "sharp";
import { CreatorError } from "./creator-error";
import type { IllustrationKeyframe, ViewCapture, ViewSource } from "./place-view";
import { registeredPixels } from "./illustration-region";
import { illustrationIdentity } from "./illustration-identity";
import { gateTruth, paintedDelta, pickCandidate, pinSky, warpKeyframe, type KeyframeView } from "./illustration-keyframe";

/** One capture. Pass bytes are the saved PNGs, already checked by the caller. */
export interface KeyframePasses {
  view: KeyframeView & Pick<ViewCapture, "objects" | "floor_id" | "mode">;
  render: Buffer; depth: Buffer; objects: Buffer;
}
/** The accepted keyframe at camera A, with A's capture, for a chained keyframe. */
export interface KeyframeChain { view: KeyframeView; depth: Buffer; image: Buffer }

// SAM-3 is prompted with this word inside the gate box (the bench's choice).
export const KEYFRAME_GATE_LABEL = "building";

const decode = (bytes: Buffer, view: KeyframeView, pngOnly = false) => registeredPixels(bytes, view.width, view.height, pngOnly);
const png = (rgba: Uint8Array, view: KeyframeView) => sharp(rgba, { raw: { width: view.width, height: view.height, channels: 4 } }).png().toBuffer();
// Image 2 may be any size or format; one bounded JPEG keeps the data URL small.
async function referenceUrl(bytes: Buffer) {
  try {
    const jpeg = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024, failOn: "error" }).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch { throw new CreatorError("Keyframe reference image is not readable", 409); }
}
async function warp(passes: KeyframePasses, chain: KeyframeChain) {
  const [render, depth, image, depthA] = await Promise.all([decode(passes.render, passes.view), decode(passes.depth, passes.view), decode(chain.image, chain.view), decode(chain.depth, chain.view)]);
  return { render, depth, warp: warpKeyframe({ view: chain.view, image, depth: depthA }, { view: passes.view, render, depth }) };
}
// The gate subject is chosen once, at preparation, from the saved geometry's
// kinds; afterwards it is rebuilt from the object pass by id alone.
const truthFor = async (passes: KeyframePasses, objectId: string) =>
  gateTruth(await decode(passes.objects, passes.view, true), passes.view.width, passes.view.height, passes.view.objects, [{ id: objectId, kind: "building" }]);

/** Provider inputs for one keyframe, plus the building the gate will measure. */
export async function prepareKeyframeInput(passes: KeyframePasses, sources: ViewSource[], art: Buffer | null, chain?: KeyframeChain) {
  const { view } = passes, objects = await decode(passes.objects, view, true);
  const truth = gateTruth(objects, view.width, view.height, view.objects, sources.flatMap(s => s.definition.objects));
  const warped = chain ? (await warp(passes, chain)).warp : undefined;
  const reference = chain ? chain.image : art;
  return {
    inputs: { image_url: `data:image/png;base64,${(warped ? await png(warped.rgba, view) : passes.render).toString("base64")}`,
      image_size: { width: view.width, height: view.height }, scene_identity: illustrationIdentity(view, sources, objects),
      keyframe_stage: chain ? "chain" as const : "first" as const, ...(reference ? { reference_url: await referenceUrl(reference) } : {}) },
    gate_object_id: truth?.object_id ?? null,
    ...(warped ? { chain: { angle: warped.angleDeg, hole_share: warped.holeShare } } : {}),
  };
}

/** Body for POST /illustration/gate, or null when no building is measurable. */
export async function keyframeGateBody(passes: KeyframePasses, objectId: string | null, imageUrls: string[]) {
  const truth = objectId ? await truthFor(passes, objectId) : null;
  if (!truth) return null;
  const { width, height } = passes.view, [x0, y0, x1, y1] = truth.box;
  return { image_urls: imageUrls, box: [Math.round(x0 * width), Math.round(y0 * height), Math.round(x1 * width), Math.round(y1 * height)], width, height, label: KEYFRAME_GATE_LABEL };
}

// A mask that does not decode at the frame size is a failed measurement.
async function maskPixels(mask: string | null, view: KeyframeView) {
  const empty = new Uint8Array(view.width * view.height);
  if (!mask) return empty;
  try {
    const { data, info } = await sharp(Buffer.from(mask, "base64"), { limitInputPixels: 1024 * 1024 }).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    return info.width === view.width && info.height === view.height ? data.map(v => (v > 127 ? 1 : 0)) : empty;
  } catch { return empty; }
}

/**
 * Pick and finish one candidate. `masks` is the saved gate result (null when
 * unmeasured: an outage keeps candidate 0). A chained keyframe gets the warped
 * sky pinned back, so the sky cannot drift from camera to camera.
 */
export async function finishKeyframe(passes: KeyframePasses, objectId: string | null, candidates: Buffer[], masks: (string | null)[] | null, chain?: KeyframeChain):
  Promise<Pick<IllustrationKeyframe, "gate" | "candidates" | "chosen" | "passed" | "sky_pinned"> & { bytes: Buffer; chain?: { angle: number; hole_share: number } }> {
  const { view } = passes;
  if (!candidates.length || masks && masks.length !== candidates.length) throw new Error("Each keyframe candidate needs one gate result");
  const images = await Promise.all(candidates.map(bytes => decode(bytes, view)));
  const warped = chain ? await warp(passes, chain) : undefined;
  const render = warped?.render ?? await decode(passes.render, view);
  // First keyframe: every geometry pixel came from the render. Chain: only the holes did.
  const renderMask = warped?.warp.hole ?? (await decode(passes.depth, view)).filter((_, i) => i % 4 === 0).map(v => (v ? 1 : 0));
  const painted = images.map(image => paintedDelta(render, image, renderMask));
  const truth = masks && objectId ? await truthFor(passes, objectId) : null;
  const pick = truth && masks ? pickCandidate(truth.mask, await Promise.all(masks.map(m => maskPixels(m, view))), painted, view.width, view.height) : null;
  const chosen = pick?.index ?? 0;
  const metrics = painted.map((delta, i) => {
    const match = pick?.metrics[i]?.match ?? null;
    return { iou: match?.iou ?? null, centre_dx: match?.centreDx ?? null, centre_dy: match?.centreDy ?? null, area_ratio: match?.areaRatio ?? null, painted: delta, passed: pick?.metrics[i]?.passed ?? false };
  });
  const sky = warped?.warp.sky.some(v => v) ?? false;
  const bytes = warped && sky ? await sharp(pinSky(images[chosen]!, warped.warp.rgba, warped.warp.sky, view.width, view.height), { raw: { width: view.width, height: view.height, channels: 4 } }).jpeg({ quality: 92 }).toBuffer() : candidates[chosen]!;
  return { bytes, gate: pick ? (pick.passed ? "passed" : "failed") : "unmeasured", candidates: metrics, chosen, passed: pick?.passed ?? false, sky_pinned: sky,
    ...(warped ? { chain: { angle: warped.warp.angleDeg, hole_share: warped.warp.holeShare } } : {}) };
}
