"use client";

interface Props {
  xPx: number;
  yPx: number;
  /** The pointer rests on an enterable place (world mode, map frame) —
   *  swap the crosshair for the enter ring + microlabel. */
  enterable?: boolean;
}

/**
 * Custom red-on-white crosshair cursor that follows the pointer over the
 * rendered illustration. Replaces the default cursor (which is hidden via
 * cursor-none on the image) so the click target is unambiguous on busy
 * backgrounds. The parent gates rendering on hoverPos != null + idle phase.
 * Over an enterable place it becomes an emerald ring with a tiny "enter"
 * label, matching the EnterableMarkers idle rings.
 */
export function HoverCrosshair({ xPx, yPx, enterable = false }: Props) {
  if (enterable) {
    return (
      <span
        aria-hidden
        className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${xPx}px`, top: `${yPx}px`, width: "34px", height: "34px" }}
      >
        <svg viewBox="0 0 34 34" width="34" height="34" className="block">
          <circle cx="17" cy="17" r="13" fill="none" stroke="rgba(255,255,255,0.95)" strokeWidth="3" />
          <circle cx="17" cy="17" r="13" fill="none" stroke="#10b981" strokeWidth="1.5" />
          <circle cx="17" cy="17" r="1.5" fill="#10b981" />
        </svg>
        <span className="absolute left-1/2 top-full mt-0.5 -translate-x-1/2 rounded bg-emerald-700/90 px-1 font-mono text-[9px] lowercase tracking-wide text-white">
          enter
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${xPx}px`, top: `${yPx}px`, width: "28px", height: "28px" }}
    >
      <svg viewBox="0 0 28 28" width="28" height="28" className="block">
        <circle cx="14" cy="14" r="11" fill="none" stroke="rgba(255,255,255,0.95)" strokeWidth="2.5" />
        <circle cx="14" cy="14" r="11" fill="none" stroke="#ef4444" strokeWidth="1.25" />
        <line x1="14" y1="2" x2="14" y2="9" stroke="#ef4444" strokeWidth="1.5" />
        <line x1="14" y1="19" x2="14" y2="26" stroke="#ef4444" strokeWidth="1.5" />
        <line x1="2" y1="14" x2="9" y2="14" stroke="#ef4444" strokeWidth="1.5" />
        <line x1="19" y1="14" x2="26" y2="14" stroke="#ef4444" strokeWidth="1.5" />
        <circle cx="14" cy="14" r="1.5" fill="#ef4444" />
      </svg>
    </span>
  );
}
