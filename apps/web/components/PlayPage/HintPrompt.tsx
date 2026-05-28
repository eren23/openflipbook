"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  /** Click position in image-relative pixels. */
  xPx: number;
  yPx: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

const MAX_LEN = 240;

/**
 * Inline replacement for the old `window.prompt` on ⌘/Ctrl-click. Floats
 * a small text bubble anchored above the click point inside the image
 * figure. Enter submits, Esc cancels, click-outside cancels.
 */
export function HintPrompt({ xPx, yPx, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    onSubmit(value.trim().slice(0, MAX_LEN));
  };

  return (
    <div
      className="pointer-events-auto absolute z-30 -translate-x-1/2 -translate-y-full"
      style={{ left: `${xPx}px`, top: `${Math.max(yPx - 12, 0)}px` }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-center gap-1.5 rounded-full border border-[var(--color-edge)] bg-[var(--color-canvas)]/95 px-2.5 py-1 text-sm shadow-lg backdrop-blur"
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="add a note — e.g. cross-section, for a 5-year-old"
          maxLength={MAX_LEN}
          aria-label="Click hint"
          className="w-80 bg-transparent text-sm leading-tight outline-none placeholder:text-[var(--color-ink)]/40"
        />
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-2 py-0.5 text-[11px] opacity-60 hover:opacity-100"
          aria-label="Cancel"
        >
          esc
        </button>
        <button
          type="submit"
          className="rounded-full bg-[var(--color-ink)] px-2.5 py-0.5 text-[11px] text-[var(--color-canvas)]"
          aria-label="Submit hint"
        >
          ↵
        </button>
      </form>
    </div>
  );
}
