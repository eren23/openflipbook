"use client";

import { useEffect } from "react";

export interface KeyboardShortcutHandlers {
  onBack: () => void;
  onForward: () => void;
  onToggleMap: () => void;
  onToggleScrubber: () => void;
  onOpenQuickbar: () => void;
  onToggleHelp: () => void;
  onToggleCodex: () => void;
  onCloseOverlays: () => void;
  /** True while at least one overlay (help / quickbar / context menu / codex) is open. */
  anyOverlayOpen: boolean;
}

/**
 * Global keyboard bindings for the play surface. Esc closes overlays
 * regardless of focus; everything else short-circuits when the user is
 * typing in an input / textarea / contenteditable, or holding a modifier.
 *
 * Modifier rule (`e.metaKey || e.ctrlKey || e.altKey`) keeps DevTools, page
 * reload, and copy/paste reachable while the play surface owns the bare-key
 * shortcuts. The hook ignores Shift on its own — Backspace+Shift means
 * "forward" by design.
 *
 * Bindings:
 *   ←        Back
 *   →        Forward
 *   Backspace          Back (Shift = forward)
 *   M / m    Toggle map view
 *   T / t    Toggle time-scrubber
 *   K / k    Toggle codex panel
 *   /        Open quickbar
 *   ?        Toggle help overlay
 *   Esc      Close any open overlay
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  const {
    onBack,
    onForward,
    onToggleMap,
    onToggleScrubber,
    onOpenQuickbar,
    onToggleHelp,
    onToggleCodex,
    onCloseOverlays,
    anyOverlayOpen,
  } = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // Esc always closes overlays even when typing in the quickbar.
      if (e.key === "Escape") {
        if (anyOverlayOpen) {
          e.preventDefault();
          onCloseOverlays();
        }
        return;
      }

      if (inField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onBack();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onForward();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        if (e.shiftKey) onForward();
        else onBack();
      } else if (e.key.toLowerCase() === "m") {
        e.preventDefault();
        onToggleMap();
      } else if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        onToggleScrubber();
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        onToggleCodex();
      } else if (e.key === "/") {
        e.preventDefault();
        onOpenQuickbar();
      } else if (e.key === "?") {
        e.preventDefault();
        onToggleHelp();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    anyOverlayOpen,
    onBack,
    onForward,
    onToggleMap,
    onToggleScrubber,
    onOpenQuickbar,
    onToggleHelp,
    onToggleCodex,
    onCloseOverlays,
  ]);
}
