// The contain-rect measurer, incl. THE #48 REGRESSION PIN: callers mount
// BEFORE the conditional <figure> exists (permalink / continue hydration), so
// the effect must POLL until the img appears and then attach — a one-shot
// bail was the invisible-marquee / maskless-edit bug. happy-dom has no
// ResizeObserver, so a fake records observe/disconnect and lets tests fire
// resize callbacks by hand.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

import { useContainRect } from "./useContainRect";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

interface Dims {
  clientWidth: number;
  clientHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}

function makeImg(dims: Dims): { img: HTMLImageElement; dims: Dims } {
  const img = document.createElement("img");
  for (const prop of Object.keys(dims) as (keyof Dims)[]) {
    Object.defineProperty(img, prop, { get: () => dims[prop], configurable: true });
  }
  return { img, dims };
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useContainRect", () => {
  it("measures an already-mounted img and observes it for resize", () => {
    const { img } = makeImg({
      clientWidth: 160,
      clientHeight: 90,
      naturalWidth: 320,
      naturalHeight: 180,
    });
    const ref = createRef<HTMLImageElement | null>();
    ref.current = img;
    const { result } = renderHook(() => useContainRect(ref));
    // Same aspect: content fills the box, no letterbox offsets.
    expect(result.current).toEqual({ width: 160, height: 90, offsetX: 0, offsetY: 0 });
    expect(FakeResizeObserver.instances[0]!.observed).toEqual([img]);
  });

  it("letterboxes a portrait image inside a wide box (the overlay-alignment math)", () => {
    const { img } = makeImg({
      clientWidth: 160,
      clientHeight: 90,
      naturalWidth: 90,
      naturalHeight: 90,
    });
    const ref = createRef<HTMLImageElement | null>();
    ref.current = img;
    const { result } = renderHook(() => useContainRect(ref));
    // 1:1 content in a 16:9 box → pillarboxed: 90px wide, centred.
    expect(result.current).toEqual({ width: 90, height: 90, offsetX: 35, offsetY: 0 });
  });

  it("#48 pin: a ref that's null at mount polls until the img appears, then attaches", () => {
    const ref = createRef<HTMLImageElement | null>();
    const { result } = renderHook(() => useContainRect(ref));
    expect(result.current).toBeNull();

    // Nothing to attach yet — polling, not bailing.
    act(() => void vi.advanceTimersByTime(600));
    expect(result.current).toBeNull();
    expect(FakeResizeObserver.instances.length).toBe(0);

    // The figure mounts late (permalink / continue hydration)…
    const { img } = makeImg({
      clientWidth: 160,
      clientHeight: 90,
      naturalWidth: 320,
      naturalHeight: 180,
    });
    ref.current = img;
    act(() => void vi.advanceTimersByTime(300));

    // …and the hook attached for real: measured + ResizeObserver wired.
    expect(result.current).toEqual({ width: 160, height: 90, offsetX: 0, offsetY: 0 });
    expect(FakeResizeObserver.instances.length).toBe(1);
    expect(FakeResizeObserver.instances[0]!.observed).toEqual([img]);

    // The poll stopped — more time creates no duplicate observers.
    act(() => void vi.advanceTimersByTime(1200));
    expect(FakeResizeObserver.instances.length).toBe(1);
  });

  it("returns null until the image has natural dimensions, re-measures on load", () => {
    const { img, dims } = makeImg({
      clientWidth: 160,
      clientHeight: 90,
      naturalWidth: 0, // not decoded yet
      naturalHeight: 0,
    });
    const ref = createRef<HTMLImageElement | null>();
    ref.current = img;
    const { result } = renderHook(() => useContainRect(ref));
    expect(result.current).toBeNull();

    dims.naturalWidth = 320;
    dims.naturalHeight = 180;
    act(() => void img.dispatchEvent(new Event("load")));
    expect(result.current).toEqual({ width: 160, height: 90, offsetX: 0, offsetY: 0 });
  });

  it("re-measures when the ResizeObserver fires", () => {
    const { img, dims } = makeImg({
      clientWidth: 160,
      clientHeight: 90,
      naturalWidth: 320,
      naturalHeight: 180,
    });
    const ref = createRef<HTMLImageElement | null>();
    ref.current = img;
    const { result } = renderHook(() => useContainRect(ref));
    expect(result.current?.width).toBe(160);

    dims.clientWidth = 320;
    dims.clientHeight = 180;
    act(() => FakeResizeObserver.instances[0]!.cb());
    expect(result.current).toEqual({ width: 320, height: 180, offsetX: 0, offsetY: 0 });
  });

  it("cleans up: unmount stops the poll and disconnects the observer", () => {
    // Attached case → observer disconnected.
    const { img } = makeImg({
      clientWidth: 160,
      clientHeight: 90,
      naturalWidth: 320,
      naturalHeight: 180,
    });
    const attachedRef = createRef<HTMLImageElement | null>();
    attachedRef.current = img;
    const attached = renderHook(() => useContainRect(attachedRef));
    attached.unmount();
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);

    // Still-polling case → no late attach after unmount.
    const lateRef = createRef<HTMLImageElement | null>();
    const polling = renderHook(() => useContainRect(lateRef));
    polling.unmount();
    lateRef.current = img;
    act(() => void vi.advanceTimersByTime(900));
    expect(FakeResizeObserver.instances.length).toBe(1); // only the first test's
  });

  it("no ref at all stays null (callers fall back to wrapper-relative %)", () => {
    const { result } = renderHook(() => useContainRect(undefined));
    act(() => void vi.advanceTimersByTime(600));
    expect(result.current).toBeNull();
  });
});
