import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorldEntityGeo } from "@openflipbook/config";

import { RouteDrawLayer } from "./RouteDrawLayer";

const geo = (label: string, x: number, y: number, w: number, d: number, height: number, extra: Partial<WorldEntityGeo> = {}) =>
  ({ id: `geo_${label}`, entity_id: null, kind: "place", label, pos: { x, y }, footprint: { w, d }, height, visual: "", state: {}, confidence: 1, source: "extracted", updated_at: "", ...extra }) as unknown as WorldEntityGeo;

const FRAME = { x: 0, y: 0, w: 100, h: 60 };
const TOWN = [geo("The Copper Kettle", 37, 29.1, 16.2, 13.3, 7.2), geo("Bellfounder Hall", 68.6, 32.6, 19.8, 16.3, 7.5)];

// jsdom gives every element a zero box; pin one so normalized points are real.
function pinBox(el: Element, box = { left: 0, top: 0, width: 400, height: 240 }) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect);
}

function drawLine(from: [number, number], to: [number, number], steps = 12) {
  const canvas = screen.getByTestId("route-canvas");
  pinBox(canvas);
  fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1] });
  for (let i = 1; i <= steps; i++) {
    fireEvent.pointerMove(canvas, { clientX: from[0] + ((to[0] - from[0]) * i) / steps, clientY: from[1] + ((to[1] - from[1]) * i) / steps });
  }
  fireEvent.pointerUp(canvas);
}

describe("RouteDrawLayer", () => {
  it("keeps a whole stroke that arrives in one batch (live pointer bursts)", () => {
    render(<RouteDrawLayer entities={TOWN} frame={FRAME} onClose={() => {}} />);
    const canvas = screen.getByTestId("route-canvas");
    pinBox(canvas);
    const at = (x: number) => ({ clientX: x, clientY: 120, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1 });
    act(() => {
      canvas.dispatchEvent(new MouseEvent("pointerdown", at(40)));
      for (let x = 60; x <= 360; x += 20) canvas.dispatchEvent(new MouseEvent("pointermove", at(x)));
      canvas.dispatchEvent(new MouseEvent("pointerup", at(360)));
    });
    expect(screen.getAllByRole("button", { name: /^Checkpoint/ }).length).toBeGreaterThanOrEqual(2);
  });

  it("turns a drawn line into checkpoints with a start and an end", () => {
    render(<RouteDrawLayer entities={TOWN} frame={FRAME} onClose={() => {}} />);
    expect(screen.getByTestId("route-summary").textContent).toMatch(/Drag across the map/);
    drawLine([40, 120], [360, 120]);
    const marks = screen.getAllByRole("button", { name: /^Checkpoint/ });
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks[0]!.getAttribute("data-checkpoint")).toBe("start");
    expect(marks[marks.length - 1]!.getAttribute("data-checkpoint")).toBe("end");
    expect(screen.getByTestId("route-summary").textContent).toMatch(/\d+ units · \d+ keyframes/);
  });

  it("selects a checkpoint and clears the route", () => {
    render(<RouteDrawLayer entities={TOWN} frame={FRAME} onClose={() => {}} />);
    drawLine([40, 120], [360, 120]);
    const marks = screen.getAllByRole("button", { name: /^Checkpoint/ });
    fireEvent.click(marks[marks.length - 1]!);
    expect(marks[marks.length - 1]!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("Clear"));
    expect(screen.queryAllByRole("button", { name: /^Checkpoint/ })).toHaveLength(0);
  });

  it("drops the stroke when the page moves to another map", () => {
    // The layer stays mounted across a walk to the next page. A stroke is in
    // the image's own coordinates, so carrying it over would silently redraw
    // the old route on a map it was never drawn on.
    const { rerender } = render(<RouteDrawLayer entities={TOWN} frame={FRAME} onClose={() => {}} />);
    drawLine([40, 120], [360, 120]);
    expect(screen.getAllByRole("button", { name: /^Checkpoint/ }).length).toBeGreaterThanOrEqual(2);
    rerender(<RouteDrawLayer entities={TOWN} frame={{ x: -65, y: -39.6, w: 231.3, h: 136.6 }} onClose={() => {}} />);
    expect(screen.queryAllByRole("button", { name: /^Checkpoint/ })).toHaveLength(0);
    expect(screen.getByTestId("route-summary").textContent).toMatch(/Drag across the map/);
  });

  it("closes on Done", () => {
    const onClose = vi.fn();
    render(<RouteDrawLayer entities={TOWN} frame={FRAME} onClose={onClose} />);
    fireEvent.click(screen.getByText("Done"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says when a camera had to step out of a building", () => {
    render(<RouteDrawLayer entities={TOWN} frame={FRAME} onClose={() => {}} />);
    // Straight through the inn at (37, 29.1) on a 100x60 frame.
    drawLine([80, 116], [240, 116]);
    expect(screen.getByTestId("route-summary").textContent).toMatch(/\d+ cameras stepped aside/);
  });

  // Accept is the paid half: the layer renders the control image for every
  // camera (the renderer is ours) and the backend only paints and links.
  it("paints only the shots worth painting, and says what it spent", async () => {
    const posted: { shots: { index: number; control_data_url: string; sees: [string, number][] }[] }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ clips: [{ video_url: "a.mp4" }, { video_url: "b.mp4" }], spent_usd: 0.41 }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    // jsdom ships neither ImageData nor a canvas 2d context, and with a context
    // stubbed the preview effect gets far enough to need the former.
    vi.stubGlobal("ImageData", class { constructor(public data: unknown, public width: number, public height: number) {} });
    // jsdom's canvas has no 2d context unless one is stubbed
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      putImageData: () => {}, clearRect: () => {}, drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAA");

    render(<RouteDrawLayer entities={TOWN} frame={FRAME} sessionId="s1" onClose={() => {}} />);
    drawLine([40, 120], [360, 120]);
    const accept = screen.getByTestId("route-accept");
    expect(accept.textContent).toMatch(/^Paint \d+ shots?$/);
    await act(async () => { fireEvent.click(accept); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/world/s1/walk");
    const body = posted[0]!;
    expect(body.shots.length).toBeGreaterThan(0);
    // every shot carries its own control image and what it sees
    for (const s of body.shots) {
      expect(s.control_data_url).toMatch(/^data:image\/png/);
      expect(Array.isArray(s.sees)).toBe(true);
    }
    expect(screen.getByTestId("route-walk-status").textContent).toMatch(/2 clips · \$0\.41/);
    vi.unstubAllGlobals();
  });

  it("offers nothing to paint without a session to bill", () => {
    vi.stubGlobal("ImageData", class { constructor(public data: unknown, public width: number, public height: number) {} });
    render(<RouteDrawLayer entities={TOWN} frame={FRAME} onClose={() => {}} />);
    drawLine([40, 120], [360, 120]);
    expect(screen.queryByTestId("route-accept")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("shows a walk already painted on this page, before anything is drawn", () => {
    render(
      <RouteDrawLayer
        entities={TOWN}
        frame={FRAME}
        sessionId="s1"
        savedWalk={{
          clips: [{ from_shot: 0, to_shot: 2, video_url: "a.mp4", model: "m", seconds: 5 }],
          shots: [{ index: 0, distance: 0, sees: [{ label: "The Copper Kettle", share: 0.3 }] }],
          spent_usd: 0.19,
          created_at: "2026-09-20T00:00:00Z",
        }}
        onClose={() => {}}
      />,
    );
    // no stroke drawn, and the paid walk is still there
    expect(screen.getByTestId("route-walk-status").textContent).toMatch(/1 clip · \$0\.19/);
  });
});
