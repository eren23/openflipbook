"use client";

interface Props {
  /** Increment on each fresh click so React remounts and the CSS animation restarts. */
  rippleKey: string | number;
  xPx: number;
  yPx: number;
}

/**
 * Animated focus ring at the user's last click point while a generation
 * is in flight. Pure visual; the parent decides when to render it (only
 * when phase === "generating" and the click was a tap, not a stroke).
 */
export function ClickRipple({ rippleKey, xPx, yPx }: Props) {
  return (
    <span
      key={rippleKey}
      aria-hidden
      className="pointer-events-none absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 shadow-lg"
      style={{
        left: `${xPx}px`,
        top: `${yPx}px`,
        animation: "ec-ripple 1.2s ease-out infinite",
      }}
    />
  );
}
