"use client";

interface Props {
  /** Pixel-space stroke points captured during a Shift-drag scribble. */
  pxPoints: { x: number; y: number }[];
}

/**
 * Renders the user's freehand annotation stroke as two stacked polylines —
 * a white halo for contrast on any background, with a red stroke on top.
 * Coordinates are in image-element pixel space; the parent positions the
 * overlay over the image.
 *
 * Returns null for strokes shorter than 2 points (single-tap noise).
 */
export function StrokeOverlay({ pxPoints }: Props) {
  if (pxPoints.length < 2) return null;
  const points = pxPoints.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
      style={{ overflow: "visible" }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="rgba(255,255,255,0.95)"
        strokeWidth={10}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <polyline
        points={points}
        fill="none"
        stroke="#ef4444"
        strokeWidth={5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
