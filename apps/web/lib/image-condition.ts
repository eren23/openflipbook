"use client";

/**
 * Image conditioning — build the weighted reference stack that grounds a new
 * page in the world it came from. Order encodes weight: the region you came
 * from (strongest) → the whole parent (local world) → a global anchor (style,
 * anti-drift). Crops happen here on canvas (the backend has no Pillow); the
 * backend just uploads these data URLs and hands them to nano-banana.
 */

export type ConditionRole = "region" | "parent" | "anchor" | "style";

export interface ConditionRefs {
  urls: string[];
  roles: ConditionRole[];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Crop rectangle (normalised 0..1) of `frac` per axis, centred on the click and
 * clamped so it stays inside the image. Pure — the geometry the region crop draws.
 */
export function cropBox(
  xPct: number,
  yPct: number,
  frac: number,
): { x: number; y: number; w: number; h: number } {
  const w = clamp(frac, 0, 1);
  const h = clamp(frac, 0, 1);
  const x = clamp(xPct - w / 2, 0, 1 - w);
  const y = clamp(yPct - h / 2, 0, 1 - h);
  return { x, y, w, h };
}

/**
 * Order the available references into the conditioning stack — region → parent
 * → anchor → style — dropping any that are missing. Pure. `style` is the
 * persistent medium exemplar (the root engraving/woodcut render): it rides last
 * (weakest positional weight) so it locks the art MEDIUM without crowding the
 * composition refs. The backend names it explicitly in the conditioning prompt.
 */
export function orderedRefs(refs: {
  region?: string | null;
  parent?: string | null;
  anchor?: string | null;
  style?: string | null;
}): ConditionRefs {
  const urls: string[] = [];
  const roles: ConditionRole[] = [];
  const push = (url: string | null | undefined, role: ConditionRole) => {
    if (url) {
      urls.push(url);
      roles.push(role);
    }
  };
  push(refs.region, "region");
  push(refs.parent, "parent");
  push(refs.anchor, "anchor");
  push(refs.style, "style");
  return { urls, roles };
}

/**
 * Crop a `frac`-sized region around (xPct,yPct) of `src` (a data URL or an
 * http(s) URL) → a JPEG data URL. `crossOrigin="anonymous"` keeps the canvas
 * untainted when `src` is a persisted blob on another origin (R2/Minio), so
 * `toDataURL` doesn't throw a SecurityError — that's what made the region crop
 * (the "from corners" signal) silently drop on continued sessions. Needs the
 * blob store to send CORS headers (Minio does by default; R2 needs CORS
 * enabled). Best-effort; on any failure the caller falls back to whole-parent
 * conditioning.
 */
export async function cropRegion(
  src: string,
  xPct: number,
  yPct: number,
  frac = 0.42,
): Promise<string> {
  return cropRegionRect(src, cropBox(xPct, yPct, frac));
}

/** Crop an exact normalized box of `src` → a JPEG data URL (the general form;
 *  the ladder passes the routing window so the reference IS the promise). */
export async function cropRegionRect(
  src: string,
  box: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const img = new Image();
  // Must be set before `src`. No-op for same-origin data URLs.
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = src;
  await img.decode();
  const sx = box.x * img.naturalWidth;
  const sy = box.y * img.naturalHeight;
  const sw = Math.max(1, box.w * img.naturalWidth);
  const sh = Math.max(1, box.h * img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

/**
 * Assemble the ordered conditioning stack for a generation: region crop (parent
 * at the click) → whole parent → global anchor → style exemplar. No click
 * (query/root) → no region crop. The region crop is best-effort. `styleDataUrl`
 * is the persistent medium reference (root/pinned render); thread it on every
 * path so the art medium stays locked across the session.
 */
export async function buildConditionRefs(opts: {
  parentDataUrl?: string | null;
  anchorDataUrl?: string | null;
  styleDataUrl?: string | null;
  click?: { xPct: number; yPct: number } | null;
  regionFrac?: number;
  // Exact region window (normalized image space) — wins over click+regionFrac.
  // The descent ladder passes its ROUTING window here, so the conditioning
  // crop is exactly the closeup/submap the user was promised.
  regionBox?: { x: number; y: number; w: number; h: number } | null;
  // The whole parent IS the region (entering from a closeup that already
  // fills the frame): no canvas pass, and the separate parent role is
  // dropped — it would be a byte-duplicate of the region.
  regionWhole?: boolean;
}): Promise<ConditionRefs> {
  if (opts.regionWhole && opts.parentDataUrl) {
    return orderedRefs({
      region: opts.parentDataUrl,
      parent: null,
      anchor: opts.anchorDataUrl ?? null,
      style: opts.styleDataUrl ?? null,
    });
  }
  let region: string | null = null;
  if (opts.parentDataUrl && (opts.regionBox || opts.click)) {
    try {
      region = await cropRegionRect(
        opts.parentDataUrl,
        opts.regionBox ??
          cropBox(
            opts.click!.xPct,
            opts.click!.yPct,
            opts.regionFrac ?? 0.42,
          ),
      );
    } catch {
      region = null;
    }
  }
  return orderedRefs({
    region,
    parent: opts.parentDataUrl ?? null,
    anchor: opts.anchorDataUrl ?? null,
    style: opts.styleDataUrl ?? null,
  });
}
