"use client";

interface Props {
  /** Increment per rejected tap so React remounts and the fade restarts. */
  nudgeKey: string | number;
  xPx: number;
  yPx: number;
}

/**
 * A gentle "nothing to explore here" pill shown at the tap point when the
 * click resolver confidently reports the spot is empty (groundable=false) —
 * so a tap on open sky / water / blank margin nudges instead of burning a
 * generation on a confabulated page. Pure visual; auto-fades via CSS.
 */
export function BlankTapNudge({ nudgeKey, xPx, yPx }: Props) {
  return (
    <span
      key={nudgeKey}
      aria-hidden
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium text-white/95 shadow-lg backdrop-blur"
      style={{
        left: `${xPx}px`,
        top: `${yPx - 12}px`,
        animation: "ec-nudge 1.6s ease-out forwards",
      }}
    >
      nothing to explore here
    </span>
  );
}
