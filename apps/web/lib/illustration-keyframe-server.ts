/**
 * Keyframe painting on one capture: the render, depth and object passes of a
 * saved view or of one motion-study frame, with that frame's camera. Nothing
 * here reads a view id, a job or storage, so path videos reuse it.
 * prepare -> one paid submit (caller) -> gate request (caller) -> finish.
 */
import sharp from "sharp";
import { createHash } from "node:crypto";
import { CreatorError } from "./creator-error";
import type { IllustrationKeyframe, KeyframeReferencePreparation, SourceArtworkLandmark, ViewSource } from "./place-view";
import { prepareKeyframeCameraGuides } from "./illustration-camera-guide";
import { prepareKeyframeMapReference } from "./illustration-landmarks";
import { registeredPixels } from "./illustration-region";
import { illustrationIdentity } from "./illustration-identity";
import { compositeChain, gateSubject, gateTruth, KEYFRAME_GATE, KEYFRAME_GATE_LABEL, objectIds, paintedDelta, pickCandidate, warpKeyframe, type KeyframePasses, type KeyframeView, type KeyframeWarp } from "./illustration-keyframe";
export type { KeyframePasses };

/** One capture. Pass bytes are the saved PNGs, already checked by the caller. */
/** The accepted keyframe at camera A, with A's capture, for a chained keyframe. A's camera must be in B's world frame. */
export interface KeyframeChain { view: KeyframeView; depth: Buffer; image: Buffer }

const decode = (bytes: Buffer, view: KeyframeView, pngOnly = false) => registeredPixels(bytes, view.width, view.height, pngOnly);
// A coherent aerial reference is a competing image to edit in Qwen. Small,
// reordered crops keep actual source colour/linework without its camera/layout.
// No patch contains more than one sixth of the source's shorter dimension.
export async function prepareKeyframeReference(bytes: Buffer) {
  try {
    const image = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024, failOn: "error" }), metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1) throw new Error("A reference must contain one image");
    const { data, info } = await image.rotate().flatten({ background: "#ffffff" }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tile = Math.min(128, Math.floor(Math.min(info.width, info.height) / 6)), gutter = 8;
    if (tile < 1) throw new Error("Source artwork is too small for material crops");
    const cropAt = (x: number, y: number) => ({ left: Math.max(0, Math.min(info.width - tile, Math.round(x - tile / 2))),
      top: Math.max(0, Math.min(info.height - tile, Math.round(y - tile / 2))), width: tile, height: tile });
    // Reject patches containing warm, pale parchment, including rotated label
    // fragments at a crop edge. No label pixels are blurred or painted over.
    const labelStrip = (crop: ReturnType<typeof cropAt>) => {
      let paperPixels = 0;
      for (let y = crop.top; y < crop.top + tile; y++) {
        for (let x = crop.left; x < crop.left + tile; x++) {
          const p = (y * info.width + x) * 3, r = data[p]!, g = data[p + 1]!, b = data[p + 2]!;
          const paper = r >= 155 && g >= 110 && b >= 55 && r - g >= 10 && r - g <= 80 && g - b >= 15 && g - b <= 85;
          if (paper) paperPixels++;
        }
      }
      return paperPixels >= tile * tile * .04;
    };
    const selected = Array.from({ length: 16 }, (_, index) => {
      const x = info.width * (.125 + (index % 4) * .25), y = info.height * (.25 + Math.floor(index / 4) * .2);
      // Do not include the overview horizon. Search around the sample within
      // the same source neighbourhood when its first crop includes a label.
      for (const [dx, dy] of [[0, 0], [0, -.75], [-.75, 0], [.75, 0], [0, .75], [-.75, -.75], [.75, -.75], [-.75, .75], [.75, .75]]) {
        const crop = cropAt(x + dx! * tile, Math.max(tile / 2 + info.height * .12, y + dy! * tile));
        if (!labelStrip(crop)) return crop;
      }
      throw new Error("Source artwork has no label-free material crop");
    });
    const order = [5, 14, 3, 8, 15, 2, 9, 4, 10, 7, 12, 1, 0, 11, 6, 13], size = tile * 4 + gutter * 5;
    const crops = order.map((index, destination) => ({ ...selected[index]!, x: gutter + destination % 4 * (tile + gutter), y: gutter + Math.floor(destination / 4) * (tile + gutter) }));
    const tiles = await Promise.all(crops.map(async crop => ({ input: await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
      .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height }).png().toBuffer(), left: crop.x, top: crop.y })));
    const png = await sharp({ create: { width: size, height: size, channels: 3, background: "#464a4b" } }).composite(tiles).png().toBuffer();
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const reference_preparation: KeyframeReferencePreparation = { version: "source-art-material-crops-v1", source_sha256: hash(bytes), sha256: hash(png),
      source_width: info.width, source_height: info.height, width: size, height: size, tile_size: tile, gutter, crops };
    return { reference_url: `data:image/png;base64,${png.toString("base64")}`, reference_preparation };
  } catch { throw new CreatorError("Keyframe reference image is not readable", 409); }
}
// B's object pass gives each object one source in the composite (warpKeyframe).
async function warp(passes: KeyframePasses, chain: KeyframeChain) {
  const { view } = passes, [render, depth, objects, image, depthA] = await Promise.all([decode(passes.render, view), decode(passes.depth, view),
    decode(passes.objects, view, true), decode(chain.image, chain.view), decode(chain.depth, chain.view)]);
  const ids = objectIds(objects, view.width, view.height, view.objects);
  return { render, ids, warp: warpKeyframe({ view: chain.view, image, depth: depthA }, { view, render, depth, objects: ids }) };
}
// The gate subject is chosen once, at preparation, from the saved geometry's
// kinds; afterwards it is rebuilt from the object pass by id alone.
const truthFor = async (passes: KeyframePasses, objectId: string) =>
  gateTruth(await decode(passes.objects, passes.view, true), passes.view.width, passes.view.height, passes.view.objects, objectId);

/**
 * Provider inputs for one keyframe, plus the object the gate will measure.
 * A chain sends the same first-stage inputs (the render, and the art or
 * words); its warp is checked here, before any spend, and composited at finish.
 */
export async function prepareKeyframeInput(passes: KeyframePasses, sources: ViewSource[], art: Buffer | null, chain?: KeyframeChain, landmarks?: SourceArtworkLandmark[], guidance?: "saved-camera-guides-v1" | "saved-camera-controlnet-v1") {
  const { view } = passes, objects = await decode(passes.objects, view, true);
  const subject = gateSubject(objects, view.width, view.height, view.objects, sources.flatMap(s => s.definition.objects));
  const warped = chain ? (await warp(passes, chain)).warp : undefined;
  if (landmarks && !art) throw new CreatorError("Map-identity keyframes require the original source artwork.", 409);
  const mapReference = art && landmarks ? await prepareKeyframeMapReference(art, landmarks) : null;
  if (guidance && !mapReference) throw new CreatorError("Saved camera guides require map-bound landmark references", 409);
  const guides = guidance && landmarks ? await prepareKeyframeCameraGuides(passes, sources, landmarks, guidance) : null;
  const reference = mapReference ?? (art ? await prepareKeyframeReference(art) : null);
  return {
    inputs: { image_url: `data:image/png;base64,${passes.render.toString("base64")}`,
      image_size: { width: view.width, height: view.height }, scene_identity: illustrationIdentity(view, sources, objects),
      keyframe_stage: "first" as const, ...(reference ? { reference_url: reference.reference_url, reference_kind: reference.reference_preparation.version } : {}),
      ...(mapReference ? { landmark_urls: mapReference.landmark_urls, landmark_labels: mapReference.landmark_labels } : {}),
      ...(guides ? { structural_guide_url: guides.structural_guide_url, depth_guide_url: guides.depth_guide_url, ...(guides.outline_guide_url ? { outline_guide_url: guides.outline_guide_url } : {}) } : {}) },
    gate_object_id: subject?.object_id ?? null, gate_subject: subject,
    ...(reference ? { reference_preparation: { ...reference.reference_preparation, ...(guides ? { structural_guidance: guides.proof } : {}) } } : {}),
    ...(warped ? { chain: { angle: warped.angleDeg, hole_share: warped.holeShare } } : {}),
  };
}

/** Body for POST /illustration/gate, or null without a subject. `label` is the subject's word (older jobs: a building). */
export async function keyframeGateBody(passes: KeyframePasses, objectId: string | null, imageUrls: string[], label = KEYFRAME_GATE_LABEL) {
  const truth = objectId ? await truthFor(passes, objectId) : null;
  if (!truth) return null;
  const { width, height } = passes.view, [x0, y0, x1, y1] = truth.box;
  return { image_urls: imageUrls, box: [Math.round(x0 * width), Math.round(y0 * height), Math.round(x1 * width), Math.round(y1 * height)], width, height, label };
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
 * unmeasured: an outage keeps candidate 0). Without a subject (`objectId`
 * null) the silhouette is skipped and the paint check alone decides. A chained keyframe keeps A's
 * warped painting and sky wherever B sees what A saw, and takes the
 * candidate (B's own painting) only in the holes, so nothing drifts from
 * camera to camera. Each object in B's object pass comes from A wherever A
 * saw it, or whole from B's painting (warpKeyframe). The masks measure the raw candidates: the gate checks
 * that B's painting is registered before its holes are used. Among chain
 * candidates, the one closest to A's warp where A was trusted wins the tie.
 */
export async function finishKeyframe(passes: KeyframePasses, objectId: string | null, candidates: Buffer[], masks: (string | null)[] | null, chain?: KeyframeChain):
  Promise<Pick<IllustrationKeyframe, "gate" | "candidates" | "chosen" | "passed" | "sky_pinned"> & { final_image: NonNullable<IllustrationKeyframe["final_image"]>; bytes: Buffer; chain?: { angle: number; hole_share: number; composite_share: number; objects?: NonNullable<KeyframeWarp["objects"]> } }> {
  const { view } = passes;
  if (!candidates.length || masks && masks.length !== candidates.length) throw new Error("Each keyframe candidate needs one gate result");
  const decoded = await Promise.all(candidates.map(bytes => decode(bytes, view)));
  const warped = chain ? await warp(passes, chain) : undefined;
  const composites = warped && decoded.map(image => compositeChain(warped.warp, image, view.width, view.height));
  const render = warped?.render ?? await decode(passes.render, view);
  // First keyframe: every geometry pixel came from the render. Chain: the
  // composite takes the candidate only in the holes (B's sky too when A has
  // none), so judge the candidate's own pixels there, not A's warp or the
  // feather. Each object the candidate paints whole and that takes 5% of the
  // frame is judged on its own too; an object from A, or ground, is not.
  const renderMask = warped?.warp.hole ?? (await decode(passes.depth, view)).filter((_, i) => i % 4 === 0).map(v => (v ? 1 : 0));
  const fresh = warped?.ids.map(k => (warped.warp.sources?.get(k) === "candidate" ? k : -1));
  const painted = decoded.map(image => paintedDelta(render, image, renderMask, fresh));
  // Chain: how far each raw candidate strays from A's warp where A was trusted (not a hole, not sky).
  const trusted = warped?.warp.hole.map((h, t) => (h || warped.warp.sky[t] ? 0 : 1));
  const agreement = warped && trusted && decoded.map(image => paintedDelta(warped.warp.rgba, image, trusted));
  const truth = masks && objectId ? await truthFor(passes, objectId) : null;
  const pick = truth && masks ? pickCandidate(truth.mask, await Promise.all(masks.map(m => maskPixels(m, view))), painted, view.width, view.height, KEYFRAME_GATE, agreement)
    : objectId ? null : pickCandidate(null, [], painted, view.width, view.height, KEYFRAME_GATE, agreement);
  const chosen = pick?.index ?? 0;
  const metrics = painted.map((delta, i) => {
    const match = pick?.metrics[i]?.match ?? null;
    return { iou: match?.iou ?? null, centre_dx: match?.centreDx ?? null, centre_dy: match?.centreDy ?? null, area_ratio: match?.areaRatio ?? null, painted: delta, passed: pick?.metrics[i]?.passed ?? false,
      ...(agreement ? { agreement: agreement[i] ?? null } : {}) };
  });
  // Lossless encoding preserves the warp and pinned sky. Verify the decoded final
  // bytes independently of the raw-candidate camera gate; no second provider call.
  const composite = composites?.[chosen], expected = composite?.rgba ?? decoded[chosen]!;
  const bytes = composite ? await sharp(composite.rgba, { raw: { width: view.width, height: view.height, channels: 4 } }).png().toBuffer() : candidates[chosen]!;
  const finalPixels = await decode(bytes, view);
  let composition = true, opaque = true, protected_pixels = 0, changed_protected_pixels = 0;
  for (let p = 0; p < view.width * view.height; p++) {
    let same = true;
    for (let c = 0; c < 4; c++) if (finalPixels[p * 4 + c] !== expected[p * 4 + c]) same = false;
    if (!same) composition = false;
    if (finalPixels[p * 4 + 3] !== 255) opaque = false;
    if (composite?.protected[p]) {
      protected_pixels++;
      for (let c = 0; c < 4; c++) if (finalPixels[p * 4 + c] !== warped!.warp.rgba[p * 4 + c]) { changed_protected_pixels++; break; }
    }
  }
  const sha256 = (image: Buffer) => createHash("sha256").update(image).digest("hex");
  const final_image: NonNullable<IllustrationKeyframe["final_image"]> = { version: 1, sha256: sha256(bytes), candidate_sha256: sha256(candidates[chosen]!),
    width: view.width, height: view.height, method: composite ? "depth_warp_v1" : "candidate",
    invariants: { dimensions: true, opaque, composition, protected_pixels, changed_protected_pixels } };
  return { bytes, final_image, gate: pick ? (pick.passed ? "passed" : "failed") : "unmeasured", candidates: metrics, chosen, passed: pick?.passed ?? false, sky_pinned: warped?.warp.sky.some(v => v) ?? false,
    ...(warped && composites ? { chain: { angle: warped.warp.angleDeg, hole_share: warped.warp.holeShare, composite_share: composites[chosen]!.share,
      ...(warped.warp.objects ? { objects: warped.warp.objects } : {}) } } : {}) };
}
