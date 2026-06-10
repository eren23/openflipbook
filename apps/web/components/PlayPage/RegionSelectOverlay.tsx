"use client";

interface Props {
  /** Image-element pixel-space rect; the parent positions the overlay over
   *  the image and owns all coordinate math (lib/edit-mask.ts). */
  rect: { left: number; top: number; width: number; height: number };
}

/**
 * The drag-selection marquee for a mask-scoped edit: a dashed rectangle with
 * everything outside it dimmed (single-div box-shadow scrim, clipped to the
 * image box). Pure presentational, like StrokeOverlay.
 */
export function RegionSelectOverlay({ rect }: Props) {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      <div
        className="absolute rounded-sm border-2 border-dashed border-white/95"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
        }}
      />
    </div>
  );
}
