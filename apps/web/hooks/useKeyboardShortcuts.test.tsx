import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useKeyboardShortcuts, type KeyboardShortcutHandlers } from "./useKeyboardShortcuts";

function makeHandlers(overrides: Partial<KeyboardShortcutHandlers> = {}): KeyboardShortcutHandlers {
  return {
    onBack: vi.fn(),
    onForward: vi.fn(),
    onToggleMap: vi.fn(),
    onToggleScrubber: vi.fn(),
    onOpenQuickbar: vi.fn(),
    onToggleHelp: vi.fn(),
    onToggleCodex: vi.fn(),
    onCloseOverlays: vi.fn(),
    anyOverlayOpen: false,
    ...overrides,
  };
}

function press(opts: KeyboardEventInit & { key: string; from?: EventTarget }): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts });
  // Dispatching from a real element makes `e.target` resolve naturally;
  // the listener is on `window` but bubbles up the DOM.
  (opts.from ?? window).dispatchEvent(e);
  return e;
}

describe("useKeyboardShortcuts", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = () => {};
  });

  afterEach(() => {
    cleanup();
  });

  it("ArrowLeft / ArrowRight fire back / forward", () => {
    const handlers = makeHandlers();
    cleanup = renderHook(() => useKeyboardShortcuts(handlers)).unmount;
    press({ key: "ArrowLeft" });
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    press({ key: "ArrowRight" });
    expect(handlers.onForward).toHaveBeenCalledTimes(1);
  });

  it("Backspace alone goes back; Backspace+Shift goes forward", () => {
    const handlers = makeHandlers();
    cleanup = renderHook(() => useKeyboardShortcuts(handlers)).unmount;
    press({ key: "Backspace" });
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    expect(handlers.onForward).not.toHaveBeenCalled();
    press({ key: "Backspace", shiftKey: true });
    expect(handlers.onForward).toHaveBeenCalledTimes(1);
  });

  it("M / T / / / ? fire their respective handlers (case-insensitive for letters)", () => {
    const handlers = makeHandlers();
    cleanup = renderHook(() => useKeyboardShortcuts(handlers)).unmount;
    press({ key: "M" });
    press({ key: "m" });
    press({ key: "t" });
    press({ key: "/" });
    press({ key: "?" });
    expect(handlers.onToggleMap).toHaveBeenCalledTimes(2);
    expect(handlers.onToggleScrubber).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenQuickbar).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleHelp).toHaveBeenCalledTimes(1);
  });

  it("Esc only fires close when an overlay is open", () => {
    const closed = makeHandlers({ anyOverlayOpen: false });
    const r1 = renderHook(() => useKeyboardShortcuts(closed));
    press({ key: "Escape" });
    expect(closed.onCloseOverlays).not.toHaveBeenCalled();
    r1.unmount();

    const open = makeHandlers({ anyOverlayOpen: true });
    cleanup = renderHook(() => useKeyboardShortcuts(open)).unmount;
    press({ key: "Escape" });
    expect(open.onCloseOverlays).toHaveBeenCalledTimes(1);
  });

  it("ignores presses dispatched from INPUT / TEXTAREA targets", () => {
    const handlers = makeHandlers();
    cleanup = renderHook(() => useKeyboardShortcuts(handlers)).unmount;

    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "/", from: input });
    expect(handlers.onOpenQuickbar).not.toHaveBeenCalled();

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    press({ key: "M", from: textarea });
    expect(handlers.onToggleMap).not.toHaveBeenCalled();

    document.body.removeChild(input);
    document.body.removeChild(textarea);
    // contenteditable is checked at runtime via `target.isContentEditable`,
    // but happy-dom doesn't reliably expose that getter — covered via the
    // INPUT/TEXTAREA path here, and via a hand smoke-test in the browser.
  });

  it("Esc still closes overlays even when typing in an input", () => {
    const handlers = makeHandlers({ anyOverlayOpen: true });
    cleanup = renderHook(() => useKeyboardShortcuts(handlers)).unmount;
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "Escape", from: input });
    expect(handlers.onCloseOverlays).toHaveBeenCalledTimes(1);
    document.body.removeChild(input);
  });

  it("ignores presses combined with Cmd / Ctrl / Alt to keep DevTools etc. reachable", () => {
    const handlers = makeHandlers();
    cleanup = renderHook(() => useKeyboardShortcuts(handlers)).unmount;
    press({ key: "ArrowLeft", metaKey: true });
    press({ key: "/", ctrlKey: true });
    press({ key: "M", altKey: true });
    expect(handlers.onBack).not.toHaveBeenCalled();
    expect(handlers.onOpenQuickbar).not.toHaveBeenCalled();
    expect(handlers.onToggleMap).not.toHaveBeenCalled();
  });

  it("removes its keydown listener on unmount", () => {
    const handlers = makeHandlers();
    const { unmount } = renderHook(() => useKeyboardShortcuts(handlers));
    unmount();
    press({ key: "ArrowLeft" });
    expect(handlers.onBack).not.toHaveBeenCalled();
  });
});
