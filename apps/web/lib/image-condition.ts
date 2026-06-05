"use client";

/**
 * Image conditioning — build the weighted reference stack that grounds a new
 * page in the world it came from. Order encodes weight: the region you came
 * from (strongest) → the whole parent (local world) → a global anchor (style,
 * anti-drift). Crops happen here on canvas (the backend has no Pillow); the
 * backend just uploads these data URLs and hands them to nano-banana.
 */

export type ConditionRole = "region" | "parent" | "anchor";

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
 * → anchor — dropping any that are missing. Pure.
 */
export function orderedRefs(refs: {
  region?: string | null;
  parent?: string | null;
  anchor?: string | null;
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
  return { urls, roles };
}

/**
 * Crop a `frac`-sized region around (xPct,yPct) of `dataUrl` → a JPEG data URL.
 * Best-effort; on any failure the caller falls back to whole-parent conditioning.
 */
export async function cropRegion(
  dataUrl: string,
  xPct: number,
  yPct: number,
  frac = 0.42,
): Promise<string> {
  const img = new Image();
  img.decoding = "async";
  img.src = dataUrl;
  await img.decode();
  const box = cropBox(xPct, yPct, frac);
  const sx = box.x * img.naturalWidth;
  const sy = box.y * img.naturalHeight;
  const sw = Math.max(1, box.w * img.naturalWidth);
  const sh = Math.max(1, box.h * img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

/**
 * Assemble the ordered conditioning stack for a generation: region crop (parent
 * at the click) → whole parent → global anchor. No click (query/root) → no
 * region crop. The region crop is best-effort.
 */
export async function buildConditionRefs(opts: {
  parentDataUrl?: string | null;
  anchorDataUrl?: string | null;
  click?: { xPct: number; yPct: number } | null;
  regionFrac?: number;
}): Promise<ConditionRefs> {
  let region: string | null = null;
  if (opts.parentDataUrl && opts.click) {
    try {
      region = await cropRegion(
        opts.parentDataUrl,
        opts.click.xPct,
        opts.click.yPct,
        opts.regionFrac ?? 0.42,
      );
    } catch {
      region = null;
    }
  }
  return orderedRefs({
    region,
    parent: opts.parentDataUrl ?? null,
    anchor: opts.anchorDataUrl ?? null,
  });
}
