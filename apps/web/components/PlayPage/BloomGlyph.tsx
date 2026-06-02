/**
 * The "around" mark: a focal dot inside a ring — the current page and the world
 * around it. Reads cleanly at ~14px (a cross of dots looked like a "+"). Shared
 * by the /play Around button and the coach chip so the breadth move reads the
 * same everywhere. Inherits `currentColor`.
 */
export function BloomGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2.4" fill="currentColor" />
    </svg>
  );
}
