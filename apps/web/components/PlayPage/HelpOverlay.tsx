"use client";

interface Props {
  onClose: () => void;
}

/**
 * Modal that lists every keyboard shortcut. Reachable via `?` and from
 * the first-run coach overlay. Click-outside or the explicit Close
 * button dismisses; Esc handling is wired on the page so it stacks
 * properly with the quickbar / context menu.
 */
export function HelpOverlay({ onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-[var(--color-edge)] bg-[var(--color-canvas)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg">Shortcuts</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row k="←" v="Back" />
          <Row k="→" v="Forward" />
          <Row k="Backspace" v="Back (Shift = forward)" />
          <Row k="M" v="Toggle map view" />
          <Row k="T" v="Toggle time-scrubber" />
          <Row k="K" v="Toggle codex" />
          <Row k="E" v="Expand outward" />
          <Row k="/" v="Jump to page…" />
          <Row k="?" v="This help" />
          <Row k="Esc" v="Close overlay" />
          <Row k="Right-click" v="Page menu" />
          <Row k="⌘/Ctrl-click" v="Click with a note" />
          <Row k="Shift-drag" v="Circle a region to focus on it" />
        </dl>
        <button
          type="button"
          className="mt-4 w-full rounded-md border border-[var(--color-edge)] py-1.5 text-sm hover:bg-[var(--color-ink)]/10"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="font-mono text-xs opacity-80">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </div>
  );
}
