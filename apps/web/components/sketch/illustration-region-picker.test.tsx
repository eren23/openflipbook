import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import IllustrationRegionPicker from "./illustration-region-picker";
import type { SavedPlaceView } from "@/lib/place-view";
import { useState } from "react";
import type { IllustrationBrushStroke } from "@/lib/illustration-brush";
const pixels = new Uint8ClampedArray(32 * 32 * 4); pixels.set([1, 2, 3, 255]);
const fetcher = vi.fn(), bitmap = vi.fn(), close = vi.fn(), ready = vi.fn(), change = vi.fn(), paint = vi.fn();
const view = { id: "view", width: 32, height: 32, objects: [{ object_id: "roof", rgb: [1, 2, 3] }] } as SavedPlaceView;
const draw = (selected: string[] = [], disabled = false) => render(<IllustrationRegionPicker sessionId="world" view={view} imageUrl="/image.png" selected={selected} onChange={change} onReady={ready} disabled={disabled}/>);
it("moves the registered surface into the workspace without resetting tools or reloading the mask", async () => {
  const brush = vi.fn(), target = document.createElement("div");
  const props = { sessionId: "world", view, imageUrl: "/image.png", selected: ["roof"], onChange: change, onReady: ready, onBrushChange: brush, disabled: false };
  const ui = render(<IllustrationRegionPicker {...props}/>); ui.container.appendChild(target);
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole("button", { name: "Brush region" }));
  fireEvent.change(screen.getByLabelText("Brush radius"), { target: { value: "7" } });
  paint.mockClear();
  ui.rerender(<IllustrationRegionPicker {...props} surfaceTarget={target}/>);
  expect(paint).toHaveBeenCalled(); expect(paint.mock.calls.at(-1)![0].data[3]).toBe(130);
  expect(target.contains(screen.getByLabelText("Object selection overlay"))).toBe(true);
  expect(screen.getByLabelText("Brush radius")).toHaveProperty("value", "7");
  expect(screen.getByRole("button", { name: "Brush region" }).getAttribute("aria-pressed")).toBe("true");
  expect(fetcher).toHaveBeenCalledTimes(1);
  paint.mockClear(); ui.rerender(<IllustrationRegionPicker {...props}/>);
  expect(paint).toHaveBeenCalled(); expect(paint.mock.calls.at(-1)![0].data[3]).toBe(130);
  expect(target.childElementCount).toBe(0); expect(screen.getByLabelText("Brush radius")).toHaveProperty("value", "7");
});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("fetch", fetcher); vi.stubGlobal("createImageBitmap", bitmap);
  fetcher.mockResolvedValue(new Response(new Uint8Array([1]))); bitmap.mockResolvedValue({ width: 32, height: 32, close });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: pixels }), createImageData: () => ({ data: new Uint8ClampedArray(pixels.length) }), putImageData: paint } as never);
});
it("loads the private mask, paints only selected labels, and offers keyboard checkboxes", async () => {
  draw(["roof"]); await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  expect(fetcher).toHaveBeenCalledWith("/api/world/world/views/view/objects", expect.objectContaining({ cache: "no-store" })); expect(close).toHaveBeenCalledOnce();
  const output = paint.mock.calls.at(-1)![0].data as Uint8ClampedArray;
  expect([...output.subarray(0, 4)]).toEqual([30, 210, 195, 130]); expect(output.subarray(4).every(v => v === 0)).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "roof" })); expect(change).toHaveBeenCalledWith([]);
});
it("maps pointer positions in the fitted image to exact saved object labels", async () => {
  draw(); await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  const overlay = screen.getByLabelText("Object selection overlay"); vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 100, top: 200, width: 320, height: 320 } as DOMRect);
  fireEvent.pointerDown(overlay, { clientX: 105, clientY: 205 }); expect(change).toHaveBeenCalledWith(["roof"]);
  change.mockClear(); fireEvent.pointerDown(overlay, { clientX: 115, clientY: 205 }); fireEvent.pointerDown(overlay, { clientX: 99, clientY: 205 }); expect(change).not.toHaveBeenCalled();
});
it("does not change selection when disabled", async () => {
  draw([], true); await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  fireEvent.pointerDown(screen.getByLabelText("Object selection overlay"), { clientX: 1, clientY: 1 }); expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "Selected objects (0)" })).toHaveProperty("disabled", true);
});
it("paints registered strokes, erases, undoes and rolls back a cancelled pointer", async () => {
  const changed = vi.fn();
  function Picker() {
    const [strokes, setStrokes] = useState<IllustrationBrushStroke[] | undefined>();
    return <IllustrationRegionPicker sessionId="world" view={view} imageUrl="/image.png" selected={["roof"]} onChange={change} onReady={ready} disabled={false} strokes={strokes} onBrushChange={v => { changed(v); setStrokes(v); }}/>;
  }
  render(<Picker/>); await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole("button", { name: "Brush region" })); expect(ready).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole("slider", { name: "Brush radius" }), { target: { value: "1" } });
  const overlay = screen.getByLabelText("Object selection overlay"); vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 320, height: 320 } as DOMRect);
  fireEvent.pointerDown(overlay, { clientX: 5, clientY: 5, pointerId: 1, button: 0 });
  fireEvent.pointerMove(overlay, { clientX: 35, clientY: 5, pointerId: 1 }); fireEvent.pointerUp(overlay, { pointerId: 1 });
  expect(changed).toHaveBeenLastCalledWith([{ operation: "paint", radius: 1, points: [[0, 0], [3, 0]] }]);
  expect(ready).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Erase region" }));
  fireEvent.pointerDown(overlay, { clientX: 5, clientY: 5, pointerId: 2, button: 0 }); fireEvent.pointerUp(overlay, { pointerId: 2 });
  expect(ready).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "Undo region stroke" })); expect(ready).toHaveBeenLastCalledWith(true);
  fireEvent.pointerDown(overlay, { clientX: 5, clientY: 5, pointerId: 3, button: 0 }); fireEvent.pointerCancel(overlay, { pointerId: 3 });
  expect(changed.mock.calls.at(-1)![0]).toHaveLength(1); expect(ready).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Clear region strokes" })); expect(changed).toHaveBeenLastCalledWith([]); expect(ready).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "Select whole objects" })); expect(changed).toHaveBeenLastCalledWith(undefined); expect(ready).toHaveBeenLastCalledWith(true);
});
it.each(["http", "dimensions", "decode"])("fails closed on %s errors", async failure => {
  if (failure === "http") fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));
  if (failure === "dimensions") bitmap.mockResolvedValue({ width: 33, height: 32, close });
  if (failure === "decode") bitmap.mockRejectedValue(new Error("Invalid mask"));
  draw(); await screen.findByRole("alert"); expect(ready).not.toHaveBeenCalledWith(true); expect(change).not.toHaveBeenCalled();
  if (failure === "dimensions") expect(close).toHaveBeenCalledOnce();
});
it("aborts detached input reads and closes a bitmap that resolves after unmount", async () => {
  let resolve!: (v: unknown) => void; bitmap.mockImplementation(() => new Promise(r => { resolve = r; }));
  const ui = draw(); await waitFor(() => expect(bitmap).toHaveBeenCalledOnce());
  const signal = fetcher.mock.calls[0]![1].signal as AbortSignal; ui.unmount(); expect(signal.aborted).toBe(true);
  resolve({ width: 32, height: 32, close }); await waitFor(() => expect(close).toHaveBeenCalledOnce()); expect(ready).not.toHaveBeenCalledWith(true);
});
