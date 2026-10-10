import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorldEntityGeo } from "@openflipbook/config";

import { imageLedCheckpoints, RouteDrawLayer } from "./RouteDrawLayer";

vi.mock("./ImageLedWalk",()=>({ImageLedWalk:({open,points}:{open:boolean;points:unknown[]})=><div data-testid="image-led-panel" data-open={String(open)} data-points={points.length}/>}));

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
  // This synthetic burst is one task. Commit its final stroke once instead of
  // raycasting every intermediate stroke through a separate fireEvent act.
  act(() => {
    fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1] });
    for (let i = 1; i <= steps; i++) {
      fireEvent.pointerMove(canvas, { clientX: from[0] + ((to[0] - from[0]) * i) / steps, clientY: from[1] + ((to[1] - from[1]) * i) / steps });
    }
    fireEvent.pointerUp(canvas);
  });
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
    expect(screen.getByTestId("route-summary").textContent).toMatch(/6 checkpoints on the source map/);
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

  it("drops the old stroke and closes review when another source has identical map bounds", () => {
    const { rerender } = render(<RouteDrawLayer entities={TOWN} frame={FRAME} sessionId="s1" nodeId="map1" onClose={() => {}} />);
    drawLine([40, 120], [360, 120]);
    fireEvent.click(screen.getByTestId("route-open-illustrated"));
    expect(screen.getByTestId("image-led-panel").getAttribute("data-open")).toBe("true");
    rerender(<RouteDrawLayer entities={TOWN} frame={FRAME} sessionId="s1" nodeId="map2" onClose={() => {}} />);
    expect(screen.queryAllByRole("button", { name: /^Checkpoint/ })).toHaveLength(0);
    expect(screen.getByTestId("image-led-panel").getAttribute("data-open")).toBe("false");
    expect(screen.getByTestId("image-led-panel").getAttribute("data-points")).toBe("0");
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
    const next = screen.getByTestId("route-walk-player") as HTMLVideoElement;
    expect(next.getAttribute("src")).toBe("https://v/b.mp4");
    fireEvent.ended(next);
    expect(screen.getByTestId("route-walk-player").getAttribute("src")).toBe("https://v/a.mp4"); // loops the walk
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
    const at = (t: number) => { const current = screen.getByTestId("route-walk-player"); Object.defineProperty(current, "currentTime", { value: t, configurable: true }); fireEvent.timeUpdate(current); };
    at(2.5);
    expect(player.getAttribute("src")).toBe("https://v/a.mp4");
    at(2.95);
    expect(screen.getByTestId("route-walk-player").getAttribute("src")).toBe("https://v/b.mp4");
    // a clip without play_until still waits for its end
    at(4.9);
    expect(screen.getByTestId("route-walk-player").getAttribute("src")).toBe("https://v/b.mp4");
    fireEvent.ended(screen.getByTestId("route-walk-player"));
    expect(screen.getByTestId("route-walk-player").getAttribute("src")).toBe("https://v/a.mp4");
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
    expect(screen.getByTestId("route-walk-player").getAttribute("src")).toBe("https://v/b.mp4");
  });

  it.each(["ended", "trimmed"])("restarts a one-clip walk after its %s boundary", boundary => {
    render(<RouteDrawLayer entities={TOWN} frame={FRAME} savedWalk={{ clips: [
      { from_shot: 0, to_shot: 1, video_url: "https://v/only.mp4", model: "m", seconds: 5, play_until: 2.9 },
    ], shots: [], spent_usd: .4, created_at: "2026-10-03T00:00:00Z" }} onClose={() => {}}/>);
    const first = screen.getByTestId("route-walk-player");
    if (boundary === "ended") fireEvent.ended(first);
    else {
      Object.defineProperty(first, "currentTime", { value: 3, configurable: true });
      act(() => { fireEvent.timeUpdate(first); fireEvent.ended(first); });
    }
    const restarted = screen.getByTestId("route-walk-player") as HTMLVideoElement;
    expect(restarted).not.toBe(first); expect(restarted.getAttribute("src")).toBe("https://v/only.mp4");
    expect(restarted.currentTime).toBe(0); expect(restarted.autoplay).toBe(true);
  });

  it("opens image-led creation even when an authored 3D scene covers the route", () => {
    const garden = geo("Garden",12,30,16,10,0,{scene_id:"scene_1",scale:.5});
    render(<RouteDrawLayer entities={[garden]} frame={FRAME} sessionId="s1" nodeId="n1" onClose={()=>{}}/>);
    drawLine([40,120],[360,120]);
    const illustrated=screen.getByTestId("route-open-illustrated");
    expect(illustrated.tagName).toBe("BUTTON");
    expect(illustrated.getAttribute("href")).toBeNull();
    fireEvent.click(illustrated);
    expect(screen.getByTestId("image-led-panel").getAttribute("data-open")).toBe("true");
    expect(screen.getByTestId("route-open-3d").getAttribute("href")).toMatch(/view=walk/);
    expect(screen.getByTestId("route-open-3d").getAttribute("href")).not.toContain("workflow=illustrated-walk");
    expect(screen.queryByLabelText("Checkpoint preview")).toBeNull();
  });

  it("keeps all source checkpoints without visibility filtering or sideways placement",()=>{
    render(<RouteDrawLayer entities={[geo("Huge solid",50,30,100,60,30)]} frame={FRAME} sessionId="s1" nodeId="n1" onClose={()=>{}}/>);
    drawLine([80,120],[240,120]);
    const marks=screen.getAllByRole("button",{name:/^Checkpoint/});
    expect(marks).toHaveLength(6);
    expect(marks[0]!.style.left).toBe("20%");
    expect(marks.at(-1)!.style.left).toBe("60%");
    expect(marks.every(mark=>mark.style.top==="50%")).toBe(true);
    expect(screen.getByTestId("route-summary").textContent).not.toMatch(/skipped|stepped aside|units/);
    expect(screen.getByTestId("route-open-illustrated").textContent).toBe("Create illustrated walk");
  });

  it("offers image-led creation outside any scene, but never synchronous painting",()=>{
    render(<RouteDrawLayer entities={[]} frame={FRAME} sessionId="s1" nodeId="n1" onClose={()=>{}}/>);
    drawLine([40,120],[360,120]);
    expect(screen.getByTestId("route-open-illustrated")).toBeTruthy();
    expect(screen.queryByTestId("route-open-3d")).toBeNull();
    expect(screen.queryByTestId("route-accept")).toBeNull();
  });

  it("needs a saved source node before image-led creation",()=>{
    render(<RouteDrawLayer entities={[]} frame={FRAME} sessionId="s1" onClose={()=>{}}/>);
    drawLine([40,120],[360,120]);
    expect(screen.queryByTestId("route-open-illustrated")).toBeNull();
  });
});

describe("image-led source sampling",()=>{
  it("retains endpoints and follows a curved image route",()=>{
    const points=imageLedCheckpoints([{x:.1,y:.8},{x:.1,y:.2},{x:.9,y:.2}]);
    expect(points[0]).toEqual({x:.1,y:.8});expect(points.at(-1)).toEqual({x:.9,y:.2});
    expect(points.every(p=>Math.abs(p.x-.1)<1e-8||Math.abs(p.y-.2)<1e-8)).toBe(true);
    expect(imageLedCheckpoints([{x:.2,y:.2},{x:.2,y:.2}])).toEqual([]);
  });
});
