/**
 * The "around" mark: a focal dot ringed by four neighbours — a tiny picture of
 * what the Around action does (bloom the world around the current page). Shared
 * by the /play Around button and the coach chip so the breadth move reads the
 * same everywhere. Inherits `currentColor`.
 */
export function BloomGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <circle cx="8" cy="8" r="2.2" />
      <circle cx="8" cy="2.6" r="1.4" />
      <circle cx="13.4" cy="8" r="1.4" />
      <circle cx="8" cy="13.4" r="1.4" />
      <circle cx="2.6" cy="8" r="1.4" />
    </svg>
  );
}
