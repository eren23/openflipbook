import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SavedWalkPlayer from "./saved-walk-player";

const props = { src: "/saved/owned-walk.mp4", width: 688, height: 384, mapHref: "/sketch/world?world=owned&place=street&view=plan" };
let frames: Map<number, FrameRequestCallback>, sequence: number;
beforeEach(() => {
  frames = new Map(); sequence = 1;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { const id = sequence++; frames.set(id, callback); return id; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Saved playback cannot make API requests"); }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function decoded(video: HTMLVideoElement, time = 0) {
  for (const [key, value] of Object.entries({ duration: 5, currentTime: time, readyState: 4, ended: false, seeking: false })) Object.defineProperty(video, key, { configurable: true, writable: true, value });
  fireEvent.loadedMetadata(video); return video;
}
function player(time = 0) { const ui = render(<SavedWalkPlayer {...props}/>), video = decoded(ui.container.querySelector("video")!, time), region = screen.getByRole("region", { name: "Saved walk playback" }); act(() => region.focus()); vi.mocked(video.pause).mockClear(); return { ...ui, video, region }; }
async function tick(now: number) { await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); }); }

it("loads existing bytes with native controls and reports decoded clip seconds without a route-distance claim", () => {
  const ui = render(<SavedWalkPlayer {...props}/>), video = ui.container.querySelector("video")!;
  expect(video.controls).toBe(true); expect(video.autoplay).toBe(false); expect(video.loop).toBe(false);
  expect(screen.getByRole("button", { name: "Hold Forward" })).toHaveProperty("disabled", true);
  expect(video.play).not.toHaveBeenCalled(); decoded(video, 1.25);
  expect(screen.getByText(/1\.3 \/ 5\.0 seconds/)).toBeTruthy(); expect(screen.getByRole("progressbar", { name: "Saved clip progress" })).toHaveProperty("value", 1.25);
  expect(screen.getByRole("link", { name: "Open map" }).getAttribute("href")).toBe(props.mapHref); expect(fetch).not.toHaveBeenCalled();
});
it("starts only focused W/up input, ignores repeat and pauses on release even after focus or modifiers change", () => {
  const { video, region } = player();
  fireEvent.keyDown(window, { key: "w" }); expect(video.play).not.toHaveBeenCalled();
  fireEvent.keyDown(region, { key: "w" }); fireEvent.keyDown(region, { key: "w", repeat: true }); expect(video.play).toHaveBeenCalledTimes(1);
  video.currentTime = .7; fireEvent.timeUpdate(video); fireEvent.keyUp(window, { key: "w", ctrlKey: true });
  expect(video.pause).toHaveBeenCalled(); expect(video.currentTime).toBe(.7); expect(screen.getByText(/Paused/)).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
  fireEvent.keyDown(region, { key: "ArrowUp" }); expect(video.play).toHaveBeenCalledTimes(2); fireEvent.keyDown(region, { key: " " }); expect(screen.getByText(/Paused/)).toBeTruthy();
});
it("reverses existing frames, waits for decoding and stops at the first frame without another request", async () => {
  const { video, region } = player(.2); fireEvent.keyDown(region, { key: "s" }); await tick(100); await tick(150); expect(video.currentTime).toBeCloseTo(.15);
  Object.defineProperty(video, "seeking", { configurable: true, value: true }); await tick(200); expect(video.currentTime).toBeCloseTo(.15);
  Object.defineProperty(video, "seeking", { configurable: true, value: false }); await tick(250); expect(video.currentTime).toBeCloseTo(.05); await tick(300);
  expect(video.currentTime).toBe(0); expect(frames.size).toBe(0); expect(screen.getByText(/Paused/)).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
});
it("release freezes free reverse and opposing held inputs pause instead of fighting each other", async () => {
  const { video, region } = player(2); fireEvent.keyDown(region, { key: "s" }); await tick(0); await tick(50); fireEvent.keyUp(window, { key: "s" });
  const paused = video.currentTime; await tick(100); expect(video.currentTime).toBe(paused); expect(frames.size).toBe(0);
  fireEvent.keyDown(region, { key: "w" }); fireEvent.keyDown(region, { key: "s" }); expect(screen.getByText(/Paused/)).toBeTruthy();
  fireEvent.keyUp(window, { key: "s" }); expect(screen.getByText(/Moving forward/)).toBeTruthy(); fireEvent.keyUp(window, { key: "w" });
});
it("touch holds stop on pointer release, cancellation and lost capture", () => {
  const { video, region } = player(2), forward = screen.getByRole("button", { name: "Hold Forward" }), back = screen.getByRole("button", { name: "Hold Back" });
  fireEvent.pointerDown(forward, { button: 0, pointerId: 2, pointerType: "touch" }); expect(video.play).toHaveBeenCalled(); expect(document.activeElement).toBe(region);
  fireEvent.pointerUp(window, { pointerId: 2 }); expect(screen.getByText(/Paused/)).toBeTruthy();
  fireEvent.pointerDown(back, { button: 0, pointerId: 3, pointerType: "touch" }); expect(frames.size).toBe(1); fireEvent.pointerCancel(back, { pointerId: 3 }); expect(frames.size).toBe(0);
  fireEvent.pointerDown(back, { button: 0, pointerId: 4 }); fireEvent.lostPointerCapture(back, { pointerId: 4 }); expect(frames.size).toBe(0);
});
it("window blur, hidden tabs and leaving the control region cancel every held input", () => {
  const { video, region } = player(2);
  fireEvent.keyDown(region, { key: "w" }); fireEvent(window, new Event("blur")); expect(screen.getByText(/Paused/)).toBeTruthy();
  fireEvent.keyDown(region, { key: "s" }); expect(frames.size).toBe(1); vi.spyOn(document, "hidden", "get").mockReturnValue(true); fireEvent(document, new Event("visibilitychange")); expect(frames.size).toBe(0);
  fireEvent.keyDown(region, { key: "w" }); fireEvent.blur(region, { relatedTarget: document.body }); expect(video.pause).toHaveBeenCalled(); expect(screen.getByText(/Paused/)).toBeTruthy();
});
it("ignores modifier/editable input and lets arrow keys in native video controls use their browser behavior", () => {
  const { video, region } = player(), input = document.createElement("input"); region.append(input);
  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) fireEvent.keyDown(region, { key: "w", [modifier]: true });
  fireEvent.keyDown(input, { key: "w" }); fireEvent.keyDown(video, { key: "ArrowUp" }); expect(video.play).not.toHaveBeenCalled();
  fireEvent.keyDown(video, { key: "w" }); expect(video.play).toHaveBeenCalledTimes(1); fireEvent.keyUp(window, { key: "w" }); input.remove();
});
it("can finish a near-end partial clip, stops at the saved endpoint and jumps only within existing bytes", () => {
  const { video, region } = player(4.98); fireEvent.keyDown(region, { key: "w" }); expect(video.play).toHaveBeenCalledTimes(1);
  video.currentTime = 5; Object.defineProperty(video, "ended", { configurable: true, value: true }); fireEvent.ended(video); expect(screen.getByText(/5\.0 \/ 5\.0 seconds.*Paused/)).toBeTruthy();
  fireEvent.keyDown(region, { key: "w" }); expect(video.play).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Back to start" })); expect(video.currentTime).toBe(0); fireEvent.click(screen.getByRole("button", { name: "Show end" })); expect(video.currentTime).toBe(5); expect(fetch).not.toHaveBeenCalled();
});
it("a late play resolution cannot resume after release, source replacement or unmount", async () => {
  const { video, region, rerender, unmount } = player(); let resolve!: () => void; const held = new Promise<void>(done => { resolve = done; });
  vi.mocked(video.play).mockImplementationOnce(() => held); fireEvent.keyDown(region, { key: "w" }); fireEvent.keyUp(window, { key: "w" }); const before = vi.mocked(video.pause).mock.calls.length;
  await act(async () => resolve()); expect(vi.mocked(video.pause).mock.calls.length).toBeGreaterThan(before);
  rerender(<SavedWalkPlayer {...props} src="/saved/new.mp4"/>); expect(screen.getByText(/Loading saved clip/)).toBeTruthy();
  const newer = decoded(document.querySelector("video")!, 2); fireEvent.keyDown(region, { key: "s" }); expect(frames.size).toBe(1); unmount(); expect(frames.size).toBe(0); expect(newer.pause).toHaveBeenCalled();
});
it("disabling controls or navigating to the map pauses without generating or saving anything", () => {
  const { video, region, rerender } = player(2); fireEvent.keyDown(region, { key: "w" }); rerender(<SavedWalkPlayer {...props} disabled/>);
  expect(screen.getByRole("button", { name: "Hold Forward" })).toHaveProperty("disabled", true); expect(screen.getByText(/Paused/)).toBeTruthy();
  rerender(<SavedWalkPlayer {...props}/>); fireEvent.keyDown(region, { key: "s" }); expect(frames.size).toBe(1);
  fireEvent.click(screen.getByRole("link", { name: "Open map" })); expect(frames.size).toBe(0); expect(video.pause).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("consumed walking keys never bubble into the live camera, while editor/modifier shortcuts stay untouched", () => {
  const camera = vi.fn(), ui = render(<div onKeyDown={camera}><SavedWalkPlayer {...props}/></div>), video = decoded(ui.container.querySelector("video")!), region = screen.getByRole("region", { name: "Saved walk playback" });
  for (const key of ["w", "s", "ArrowUp", "ArrowDown", " "]) { fireEvent.keyDown(region, { key }); fireEvent.keyUp(window, { key }); }
  expect(camera).not.toHaveBeenCalled(); fireEvent.keyDown(region, { key: "w", ctrlKey: true }); expect(camera).toHaveBeenCalledTimes(1);
  const input = document.createElement("input"); region.append(input); fireEvent.keyDown(input, { key: "s" }); expect(camera).toHaveBeenCalledTimes(2);
  const native = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }); act(() => video.dispatchEvent(native)); expect(native.defaultPrevented).toBe(false); expect(camera).toHaveBeenCalledTimes(2); input.remove();
});
it("focused hold buttons support Enter and release globally after focus or modifier changes", async () => {
  const { video } = player(2), forward = screen.getByRole("button", { name: "Hold Forward" }), back = screen.getByRole("button", { name: "Hold Back" });
  act(() => forward.focus()); fireEvent.keyDown(forward, { key: "Enter" }); fireEvent.keyDown(forward, { key: "Enter", repeat: true }); expect(video.play).toHaveBeenCalledTimes(1);
  fireEvent.keyUp(window, { key: "Enter", ctrlKey: true }); expect(screen.getByText(/Paused/)).toBeTruthy();
  act(() => back.focus()); fireEvent.keyDown(back, { key: "Enter" }); await tick(0); await tick(50); expect(video.currentTime).toBeCloseTo(1.95);
  fireEvent.keyUp(window, { key: "Enter" }); expect(frames.size).toBe(0); expect(fetch).not.toHaveBeenCalled();
});
