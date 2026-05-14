"use client";

interface Props {
  x: number;
  y: number;
  beaconsHidden: boolean;
  canCopy: boolean;
  canPrune: boolean;
  canSavePostcard: boolean;
  onCopyPermalink: () => void;
  onPrune: () => void;
  onToggleBeacons: () => void;
  onSavePostcard: () => void;
  onClose: () => void;
}

/**
 * Right-click page menu: copy permalink, save postcard, toggle beacons,
 * prune branch. Positioned absolutely at the click coordinates; click-outside
 * on the full-screen backdrop dismisses.
 */
export function ContextMenu({
  x,
  y,
  beaconsHidden,
  canCopy,
  canPrune,
  canSavePostcard,
  onCopyPermalink,
  onPrune,
  onToggleBeacons,
  onSavePostcard,
  onClose,
}: Props) {
  return (
    <div className="fixed inset-0 z-[55]" onClick={onClose}>
      <div
        className="absolute min-w-[220px] rounded-md border border-[var(--color-edge)] bg-[var(--color-canvas)] py-1 text-sm shadow-xl"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-ink)]/10 disabled:opacity-50"
          disabled={!canCopy}
          onClick={onCopyPermalink}
        >
          Copy permalink
        </button>
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-ink)]/10 disabled:opacity-50"
          disabled={!canSavePostcard}
          onClick={onSavePostcard}
        >
          Save as postcard
        </button>
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-ink)]/10"
          onClick={onToggleBeacons}
        >
          {beaconsHidden ? "Show beacons" : "Hide beacons"}
        </button>
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left text-red-700 hover:bg-red-500/10 disabled:opacity-50"
          disabled={!canPrune}
          onClick={onPrune}
        >
          Prune branch from history
        </button>
      </div>
    </div>
  );
}
