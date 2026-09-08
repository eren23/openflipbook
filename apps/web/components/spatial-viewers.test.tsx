import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TourNode } from "@/lib/tour";

const state = vi.hoisted(() => ({ pending: false, error: null as string | null, navigate: vi.fn(), cancel: vi.fn(), retry: vi.fn() }));
vi.mock("@/hooks/useSpatialNavigation", () => ({ useSpatialNavigation: () => ({ ...state, motion: null }) }));
vi.mock("@/lib/spatial-mode", async original => ({ ...await original<object>(), SPATIAL_TRANSITIONS_ENABLED: true }));
import EmbedViewer from "./embed-viewer";
import TourPlayer from "./tour-player";

const nodes: TourNode[] = [
  { id: "p", parent_id: null, page_title: "Map", image_url: "map.jpg", image_key: "original", click_in_parent: null, created_at: "1" },
  { id: "c", parent_id: "p", page_title: "Tower", image_url: "tower.jpg", click_in_parent: { x_pct: .8, y_pct: .2 }, created_at: "2" },
];
beforeEach(() => { vi.clearAllMocks(); state.pending = false; state.error = null; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function commit() { act(() => state.navigate.mock.lastCall![2]()); }

it("the opt-in tour shares the navigator, commits captions at the cut, and replays", async () => {
  vi.useFakeTimers();
  render(<TourPlayer nodes={nodes} continueUrl="/play" onClose={() => {}} />);
  expect(screen.getByAltText("Map").style.transform).toBe("");
  await act(async () => { vi.advanceTimersByTime(2600); });
  expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ imageKey: "original" }), expect.objectContaining({ click: nodes[1]!.click_in_parent }), expect.any(Function));
  expect(screen.getByAltText("Map")).toBeTruthy();
  commit(); expect(screen.getByAltText("Tower")).toBeTruthy();
  act(() => vi.advanceTimersByTime(2600));
  fireEvent.click(screen.getByRole("button", { name: "Replay tour" })); commit();
  expect(screen.getByAltText("Map")).toBeTruthy();
  fireEvent.click(screen.getByTestId("tour-player"));
  expect(state.navigate).toHaveBeenCalledTimes(3);
});

it("tour close cancels work, errors expose decode retry and pause automatic steps", () => {
  vi.useFakeTimers(); state.error = "Image could not load";
  const close = vi.fn();
  render(<TourPlayer nodes={nodes} continueUrl="/play" onClose={close} />);
  act(() => vi.advanceTimersByTime(3000)); expect(state.navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry transition image" })); expect(state.retry).toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "a" }); expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" }); expect(close).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Close tour" })); expect(state.cancel).toHaveBeenCalledTimes(2);
});

it("empty tours stay empty and pending navigation does not start another timer", () => {
  vi.useFakeTimers(); state.pending = true;
  const { rerender } = render(<TourPlayer nodes={[]} continueUrl="/play" onClose={() => {}} />);
  expect(screen.queryByTestId("tour-player")).toBeNull();
  rerender(<TourPlayer nodes={nodes} continueUrl="/play" onClose={() => {}} />);
  act(() => vi.advanceTimersByTime(3000)); expect(state.navigate).not.toHaveBeenCalled();
});

it("embed navigation retains current image and stack until the shared cut", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 600 } as DOMRect);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1600);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(900);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => ({ children: url.includes("/p/") ? [nodes[1]] : [] }) })));
  const props = { sessionId: "s", initial: { id: "p", title: "Map", imageUrl: "map.jpg", imageKey: "original" }, continueUrl: "/play" };
  await act(async () => { render(<EmbedViewer {...props} />); });
  fireEvent.load(screen.getByAltText("Map"));
  fireEvent.click(screen.getByRole("button", { name: "Enter Tower" }));
  expect(state.navigate.mock.lastCall![0].imageKey).toBe("original");
  expect(screen.getByAltText("Map")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  await act(async () => commit());
  expect(screen.getByAltText("Tower")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(state.navigate.mock.lastCall![0].parentId).toBe("p");
  await act(async () => commit()); expect(screen.getByAltText("Map")).toBeTruthy();
});
