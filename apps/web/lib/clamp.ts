// Shared numeric clamps — these were hand-rolled identically across image-click,
// edit-mask, image-condition, scale-tree, world-geometry, and geo-tap.

/** Clamp `v` into `[lo, hi]`. NaN passes through (matches `v < lo ? … : v > hi ? …`). */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp into `[0, 1]`, mapping NaN to 0 (a NaN fraction is never a valid coordinate). */
export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
