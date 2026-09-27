/**
 * Does the painted building stand where the map says it does?
 *
 * The block render knows exactly which pixels belong to which place, because
 * the footprint is stored data. Segment the same building out of the painted
 * image and the two masks can be compared -- no judge, no model, no opinion.
 *
 * One caveat decides how to read the numbers: the box is a PROXY, not the
 * building. A pitched roof legitimately rises above a flat box top, so a
 * correct render scores well below 1.0 on whole-silhouette IoU and that is not
 * drift. What the footprint genuinely pins is the GROUND EXTENT -- how wide
 * the building is and where it sits. `widthRatio` and `centreDx` are the
 * numbers for the failure actually measured (a building painted wider than its
 * plot, merged with its neighbour); `iou` is context, not a verdict.
 */

export interface MaskStats {
  /** Share of the frame the mask covers, 0-1. */
  area: number;
  /** Mask centroid, in frame fractions. */
  cx: number;
  cy: number;
  /** Horizontal and vertical extent of the mask, in frame fractions. */
  width: number;
  height: number;
  pixels: number;
}

export interface SilhouetteMatch {
  /** Whole-silhouette overlap. Context: a roof above the box top lowers this
   *  honestly, so read it beside widthRatio rather than alone. */
  iou: number;
  /** Painted ground extent over stored ground extent. 1.0 is exact; above 1
   *  the building is wider than its plot, which is the merge failure. */
  widthRatio: number;
  /** Painted centre minus stored centre, in frame fractions. Signed. */
  centreDx: number;
  centreDy: number;
  /** Painted area over stored area. */
  areaRatio: number;
  truthPixels: number;
  predPixels: number;
}

/** The pixels of one entry of `control.visible`, as a 0/1 mask. */
export function maskForVisible(ids: Int32Array, visibleIndex: number): Uint8Array {
  const mask = new Uint8Array(ids.length);
  for (let i = 0; i < ids.length; i++) if (ids[i] === visibleIndex) mask[i] = 1;
  return mask;
}

/** Where a segmenter's mask PNG is opaque/white. `threshold` is on 0-255. */
export function maskFromGray(gray: Uint8Array | Uint8ClampedArray, threshold = 128): Uint8Array {
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) if (gray[i]! >= threshold) mask[i] = 1;
  return mask;
}

export function maskStats(mask: Uint8Array, width: number, height: number): MaskStats | null {
  let pixels = 0, sx = 0, sy = 0, x0 = width, x1 = -1, y0 = height, y1 = -1;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (!mask[j * width + i]) continue;
      pixels++; sx += i; sy += j;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < y0) y0 = j;
      if (j > y1) y1 = j;
    }
  }
  if (pixels === 0) return null; // an empty mask has no centre; say so rather than return zeros
  return {
    area: pixels / (width * height),
    cx: sx / pixels / width,
    cy: sy / pixels / height,
    width: (x1 - x0 + 1) / width,
    height: (y1 - y0 + 1) / height,
    pixels,
  };
}

/** Compare a painted building's mask against the footprint's own silhouette. */
export function compareMasks(
  truth: Uint8Array, pred: Uint8Array, width: number, height: number,
): SilhouetteMatch | null {
  const t = maskStats(truth, width, height);
  const p = maskStats(pred, width, height);
  if (!t || !p) return null; // nothing to compare against; not a score of zero
  let inter = 0, union = 0;
  for (let i = 0; i < truth.length; i++) {
    const a = truth[i]!, b = pred[i]!;
    if (a && b) inter++;
    if (a || b) union++;
  }
  return {
    iou: union === 0 ? 0 : inter / union,
    widthRatio: p.width / t.width,
    centreDx: p.cx - t.cx,
    centreDy: p.cy - t.cy,
    areaRatio: p.area / t.area,
    truthPixels: t.pixels,
    predPixels: p.pixels,
  };
}
