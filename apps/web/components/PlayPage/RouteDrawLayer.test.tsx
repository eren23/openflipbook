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
    const posted: { shots: { index: number; distance: number; control_data_url: string; sees: [string, number][]; observer: { pos: { x: number; y: number }; gaze: number } }[] }[] = [];
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
    const label = accept.textContent;
    await act(async () => { fireEvent.click(accept); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/world/s1/walk");
    const body = posted[0]!;
    expect(body.shots.length).toBeGreaterThan(0);
    // the button counts what is sent, and every sent shot has a neighbour to walk to
    const sent = body.shots.map((s) => s.index);
    expect(label).toBe(`Paint ${sent.length} shot${sent.length === 1 ? "" : "s"}`);
    if (sent.length > 1) for (const i of sent) expect(sent.includes(i - 1) || sent.includes(i + 1)).toBe(true);
    // every shot carries its own control image, how far along it is, and what
    // it sees -- as [label, share] pairs, the shape the backend's model takes
    for (const s of body.shots) {
      expect(s.control_data_url).toMatch(/^data:image\/png/);
      expect(typeof s.distance).toBe("number");
      // and the camera it stands at, so the backend can say where it faces
      expect(Number.isFinite(s.observer.pos.x) && Number.isFinite(s.observer.pos.y) && Number.isFinite(s.observer.gaze)).toBe(true);
      for (const seen of s.sees) {
        expect(typeof seen[0]).toBe("string");
        expect(typeof seen[1]).toBe("number");
      }
    }
    expect(screen.getByTestId("route-walk-status").textContent).toMatch(/2 clips · \$0\.41/);
    vi.unstubAllGlobals();
  // Ray-casts a control image per camera: ~4s locally, 8.5s on CI under
  // coverage. vitest 2 never enforced the 5s default on it; vitest 3 does.
  }, 30_000);

  it("crops a reopened page's map from its own bytes, not the R2 <img>", async () => {
    // Live 2026-09-24: the page showed its R2 url, drawing that <img> tainted
    // the canvas, toDataURL threw, and the walk failed before it was sent.
    const posted: { shots: { surroundings_data_url?: string }[] }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ clips: [], spent_usd: 0 }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("ImageData", class { constructor(public data: unknown, public width: number, public height: number) {} });
    const tainted = new WeakSet<HTMLCanvasElement>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return {
        putImageData: () => {}, clearRect: () => {},
        drawImage: (img: HTMLImageElement) => { if (new URL(img.src).origin !== location.origin) tainted.add(this); },
      } as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
      if (tainted.has(this)) throw new DOMException("Tainted canvases may not be exported.", "SecurityError");
      return "data:image/png;base64,AAA";
    });
    const decoded: string[] = [];
    vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (this: HTMLImageElement) {
      decoded.push(this.src);
      return Promise.resolve();
    });
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1376);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(768);
    const shown = document.createElement("img");
    shown.src = "https://pub.r2.dev/s/map.png";

    render(<RouteDrawLayer entities={TOWN} frame={FRAME} sessionId="s1" nodeId="n1" imgRef={{ current: shown }} onClose={() => {}} />);
    drawLine([40, 120], [360, 120]);
    await act(async () => { fireEvent.click(screen.getByTestId("route-accept")); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(decoded[0]!).pathname).toBe("/api/image/n1");
    expect(posted[0]!.shots.every((s) => s.surroundings_data_url === "data:image/png;base64,AAA")).toBe(true);
    vi.unstubAllGlobals();
  }, 30_000);

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

  it("plays a painted walk's clips one after another", () => {
    // Live 2026-09-24: a finished walk said "2 clips · $0.69" and nothing
    // could play it, so a paid walk was never seen.
    render(
      <RouteDrawLayer
        entities={TOWN}
        frame={FRAME}
        sessionId="s1"
        savedWalk={{
          clips: [
            { from_shot: 0, to_shot: 1, video_url: "https://v/a.mp4", model: "m", seconds: 5 },
            { from_shot: 1, to_shot: 2, video_url: "https://v/b.mp4", model: "m", seconds: 5 },
          ],
          shots: [],
          spent_usd: 0.69,
          created_at: "2026-09-24T00:00:00Z",
        }}
        onClose={() => {}}
      />,
    );
    const player = screen.getByTestId("route-walk-player") as HTMLVideoElement;
    expect(player.getAttribute("src")).toBe("https://v/a.mp4");
    fireEvent.ended(player);
    expect(player.getAttribute("src")).toBe("https://v/b.mp4");
    fireEvent.ended(player);
    expect(player.getAttribute("src")).toBe("https://v/a.mp4"); // loops the walk
  });

  it("cuts to the next clip where a clip stops moving", () => {
    // About 42% of an H3 clip is a frozen tail; play_until marks where its
    // motion ends, so the walk does not stall on it.
    render(
      <RouteDrawLayer
        entities={TOWN}
        frame={FRAME}
        sessionId="s1"
        savedWalk={{
          clips: [
            { from_shot: 0, to_shot: 1, video_url: "https://v/a.mp4", model: "m", seconds: 5, play_until: 2.9 },
            { from_shot: 1, to_shot: 2, video_url: "https://v/b.mp4", model: "m", seconds: 5 },
          ],
          shots: [],
          spent_usd: 0.69,
          created_at: "2026-10-02T00:00:00Z",
        }}
        onClose={() => {}}
      />,
    );
    const player = screen.getByTestId("route-walk-player") as HTMLVideoElement;
    const at = (t: number) => { Object.defineProperty(player, "currentTime", { value: t, configurable: true }); fireEvent.timeUpdate(player); };
    at(2.5);
    expect(player.getAttribute("src")).toBe("https://v/a.mp4");
    at(2.95);
    expect(player.getAttribute("src")).toBe("https://v/b.mp4");
    // a clip without play_until still waits for its end
    at(4.9);
    expect(player.getAttribute("src")).toBe("https://v/b.mp4");
    fireEvent.ended(player);
    expect(player.getAttribute("src")).toBe("https://v/a.mp4");
  });

  it("advances once when a clip's play_until is at its very end", () => {
    // play_until >= duration: the last timeupdate and ended fire in one task,
    // and both used to advance, so the next clip was skipped.
    render(
      <RouteDrawLayer
        entities={TOWN}
        frame={FRAME}
        sessionId="s1"
        savedWalk={{
          clips: [
            { from_shot: 0, to_shot: 1, video_url: "https://v/a.mp4", model: "m", seconds: 5, play_until: 5 },
            { from_shot: 1, to_shot: 2, video_url: "https://v/b.mp4", model: "m", seconds: 5 },
            { from_shot: 2, to_shot: 3, video_url: "https://v/c.mp4", model: "m", seconds: 5 },
          ],
          shots: [],
          spent_usd: 0.69,
          created_at: "2026-10-02T00:00:00Z",
        }}
        onClose={() => {}}
      />,
    );
    const player = screen.getByTestId("route-walk-player") as HTMLVideoElement;
    Object.defineProperty(player, "currentTime", { value: 5, configurable: true });
    act(() => { fireEvent.timeUpdate(player); fireEvent.timeUpdate(player); fireEvent.ended(player); });
    expect(player.getAttribute("src")).toBe("https://v/b.mp4");
  });

  it("hands a route that starts in a 3D place to the editor instead of painting it", () => {
    vi.stubGlobal("ImageData", class { constructor(public data: unknown, public width: number, public height: number) {} });
    // A 3D scene's map geo: 32 x 20 metres drawn at 0.5 map units per metre.
    const garden = geo("Garden", 12, 30, 16, 10, 0, { scene_id: "scene_1", scale: 0.5 });
    // An object of the same scene under the start is not the place to open.
    const inside = geo("Bench", -4, 0, 2, 2, 0.5, { scene_id: "scene_1", parent_id: "geo_Garden" });
    render(<RouteDrawLayer entities={[...TOWN, inside, garden]} frame={FRAME} sessionId="s1" onClose={() => {}} />);
    drawLine([40, 120], [360, 120]);
    expect(screen.queryByTestId("route-accept")).toBeNull();
    const link = screen.getByTestId("route-open-3d");
    expect(link.textContent).toBe("Walk it in 3D");
    const url = new URL(link.getAttribute("href")!, "http://localhost");
    expect(url.pathname).toBe("/sketch/world");
    expect(url.searchParams.get("world")).toBe("s1");
    expect(url.searchParams.get("place")).toBe("geo_Garden");
    expect(url.searchParams.get("view")).toBe("walk");
    // the stroke starts at map (10, 30): 4 m along -x from the garden's
    // centre, heading +x, which the walk calls yaw -pi/2
    const [x, z, yaw] = url.searchParams.get("route")!.split(";")[0]!.split(",").map(Number);
    expect(x).toBeCloseTo(-4, 0);
    expect(z).toBeCloseTo(0, 0);
    expect(yaw).toBeCloseTo(-Math.PI / 2, 1);
    vi.unstubAllGlobals();
  });

  it("keeps Paint when the route starts outside any 3D place", () => {
    vi.stubGlobal("ImageData", class { constructor(public data: unknown, public width: number, public height: number) {} });
    const garden = geo("Garden", 80, 50, 16, 10, 0, { scene_id: "scene_1", scale: 0.5 });
    render(<RouteDrawLayer entities={[...TOWN, garden]} frame={FRAME} sessionId="s1" onClose={() => {}} />);
    drawLine([40, 120], [360, 120]);
    expect(screen.queryByTestId("route-open-3d")).toBeNull();
    expect(screen.getByTestId("route-accept")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
