import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import PlaceViewLibrary from "./place-view-library";
import type { SavedPlaceView, ViewCapture } from "@/lib/place-view";
vi.mock("./place-illustrations", () => ({ default: () => null }));
vi.mock("./motion-study-library", () => ({ default: () => null }));

const fetcher = vi.fn(), capture = vi.fn();
const view = { id: "view", label: "Courtyard", historical: false, mode: "orbit", width: 400, height: 300 } as SavedPlaceView;
let views: SavedPlaceView[];
beforeEach(() => {
  views = []; fetcher.mockReset(); capture.mockReset(); capture.mockReturnValue({ version: 1, frozen: "camera fixture" } as unknown as ViewCapture); vi.stubGlobal("fetch", fetcher);
  fetcher.mockImplementation(async (_url, options) => options?.method === "POST" ? Response.json({ id: "view" }) : Response.json({ views }));
});
const draw = (disabled = false) => render(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} disabled={disabled}/>);
const writes = () => fetcher.mock.calls.filter(([, options]) => options?.method === "POST").map(([, options]) => JSON.parse(options.body));
it("composes the selected object explicitly without capturing or generating",async()=>{
  const compose=vi.fn();
  render(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} disabled={false} selectedObject="inn" selectedObjectLabel="Copper Kettle" onComposeSelection={compose}/>);
  fireEvent.click(screen.getByRole("button",{name:"Compose selected object"}));
  expect(compose).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("View name") as HTMLInputElement).value).toBe("Copper Kettle / close-up");
  expect(capture).not.toHaveBeenCalled();expect(writes()).toEqual([]);
});
it("opens the saved camera in illustration mode only after a successful save, retaining intent through retries",async()=>{
  const open=vi.fn(),selected=vi.fn();let fail=true;
  fetcher.mockImplementation(async(_url,options)=>{
    if(options?.body){if(fail){fail=false;throw new Error("Lost save response");} views=[view];return Response.json({id:"view"});}
    return Response.json({views});
  });
  render(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} disabled={false} onOpenIllustration={open} onSelectedViewChange={selected}/>);
  fireEvent.click(screen.getByRole("button",{name:"Save view and open illustration"}));
  await screen.findByText("Lost save response");expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Retry saved view request"}));
  await waitFor(()=>expect(open).toHaveBeenCalledOnce());
  expect(selected).toHaveBeenLastCalledWith("view");expect(capture).toHaveBeenCalledOnce();
  expect(writes()[0]).toEqual(writes()[1]);expect(writes()).toHaveLength(2);
});
it("disables composition without a selection or with a dirty scene",()=>{
  const compose=vi.fn();const ui=render(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} disabled={false} onComposeSelection={compose}/>);
  expect((screen.getByRole("button",{name:"Compose selected object"}) as HTMLButtonElement).disabled).toBe(true);
  ui.rerender(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} disabled={true} selectedObject="inn" onComposeSelection={compose}/>);
  expect((screen.getByRole("button",{name:"Compose selected object"}) as HTMLButtonElement).disabled).toBe(true);
  expect(compose).not.toHaveBeenCalled();
});
it("only captures on explicit save and keeps refresh, pass selection and history read-only", async () => {
  views = [{ ...view, historical: true }]; draw(); await screen.findByText("Historical geometry / orbit / 400 x 300");
  fireEvent.click(screen.getByRole("button", { name: "Depth" }));
  expect(new URL((screen.getByRole("img") as HTMLImageElement).src).pathname).toBe("/api/world/world/views/view/depth");
  fireEvent.click(screen.getByRole("button", { name: "Refresh saved camera views" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); expect(capture).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
});
it("retries the exact frozen capture after a lost response without recapturing", async () => {
  let lose = true; fetcher.mockImplementation(async (_url, options) => {
    if (!options?.body) return Response.json({ views });
    if (lose) { lose = false; throw new Error("Lost response"); }
    views = [view]; return Response.json({ id: "view" });
  });
  draw(); fireEvent.click(screen.getByRole("button", { name: "Save camera view" }));
  await screen.findByText("Lost response"); expect((screen.getByLabelText("View name") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved view request" }));
  await screen.findByText("Current geometry / orbit / 400 x 300");
  expect(writes()).toHaveLength(2); expect(writes()[0]).toEqual(writes()[1]); expect(capture).toHaveBeenCalledTimes(1);
});
it("unlocks the capture after a definitive stale-geometry rejection", async () => {
  fetcher.mockImplementation(async (_url, options) => options?.body ? Response.json({ error: "Geometry changed" }, { status: 409 }) : Response.json({ views: [] }));
  draw(); fireEvent.click(screen.getByRole("button", { name: "Save camera view" })); await screen.findByText("Geometry changed");
  expect((screen.getByLabelText("View name") as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save camera view" })); await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
});
it("blocks captures of dirty scenes", async () => {
  draw(true); expect((screen.getByRole("button", { name: "Save camera view" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save camera view" })); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(capture).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
});
it("does not let an older library response overwrite a newer geometry revision", async () => {
  let old!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { old = resolve; }));
  const ui = draw(); views = [{ ...view, historical: true }];
  ui.rerender(<PlaceViewLibrary sessionId="world" placeId="place" revision={2} capture={capture} disabled={false}/>);
  await screen.findByText("Historical geometry / orbit / 400 x 300");
  await act(async () => old(Response.json({ views: [view] })));
  expect(screen.queryByText("Current geometry / orbit / 400 x 300")).toBeNull();
});
it("rechecks path history before loading and never generates or recaptures", async () => {
  const onLoad = vi.fn(), path: NonNullable<SavedPlaceView["path"]> = { version: 1, duration: 6, time: 0, target_id: null, pivot: [0, 0, 0], keyframes: [0, 1].map(time => ({ time, azimuth: 0, elevation: 30, distance: 20 })) };
  views = [{ ...view, path }];
  render(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} disabled={false} onLoadPath={onLoad}/>);
  await screen.findByRole("button", { name: "Load camera path" });
  fireEvent.click(screen.getByRole("button", { name: "Load camera path" }));
  await waitFor(() => expect(onLoad).toHaveBeenCalledWith(views[0]));
  views = [{ ...view, path, historical: true }];
  fireEvent.click(screen.getByRole("button", { name: "Load camera path" }));
  await screen.findByText("Saved path geometry is no longer current");
  expect(onLoad).toHaveBeenCalledTimes(1); expect(capture).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
});
it("keeps one motion panel beside illustrations across library rerenders", async () => {
  const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    views = [{ ...view, sources: [], assets: [], path: { version: 1, duration: 6, time: 0, target_id: "inn", pivot: [0, 0, 0], keyframes: [] } }];
    const captureMotion = vi.fn(), onLoad = vi.fn();
    const ui = render(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} captureMotion={captureMotion} disabled={false} onLoadPath={onLoad}/>);
    await screen.findByRole("button", { name: "Prepare motion references" });
    for (const disabled of [true, false, true, false]) {
      ui.rerender(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} captureMotion={captureMotion} disabled={disabled} onLoadPath={onLoad}/>);
      expect(screen.getAllByLabelText("Camera motion references")).toHaveLength(1);
    }
    fireEvent.click(screen.getByRole("button", { name: "Load camera path" }));
    await waitFor(() => expect(onLoad).toHaveBeenCalledOnce());
    expect(screen.getAllByLabelText("Camera motion references")).toHaveLength(1);
    expect(warnings.mock.calls.filter(call => String(call[0]).includes("same key"))).toEqual([]);
    expect(captureMotion).not.toHaveBeenCalled();
  } finally { warnings.mockRestore(); }
});
it("does not apply a pending path load after the local scene becomes dirty", async () => {
  const onLoad = vi.fn();
  views = [{ ...view, path: { version: 1, duration: 6, time: 0, target_id: null, pivot: [0, 0, 0], keyframes: [] } }];
  const ui = render(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} disabled={false} onLoadPath={onLoad}/>);
  await screen.findByRole("button", { name: "Load camera path" });
  let finish!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Load camera path" }));
  ui.rerender(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={capture} disabled={true} onLoadPath={onLoad}/>);
  await act(async () => finish(Response.json({ views })));
  expect(onLoad).not.toHaveBeenCalled();
});
it("refreshes a historical camera explicitly, retains the ancestor and selects the new view", async () => {
  const historical = { ...view, historical: true }, refresh = vi.fn().mockResolvedValue({ version: 1, fresh: true });
  views = [historical];
  fetcher.mockImplementation(async (_url, options) => {
    if (options?.body) { views = [historical, { ...view, id: "fresh", refreshed_from: view.id }]; return Response.json({ id: "fresh" }); }
    return Response.json({ views });
  });
  render(<PlaceViewLibrary sessionId="world" placeId="place" revision={2} capture={capture} refreshView={refresh} disabled={false}/>);
  await screen.findByRole("button", { name: "Refresh saved view geometry" }); expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh saved view geometry" }));
  await screen.findByText("Current geometry / orbit / 400 x 300");
  expect(refresh).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledWith(historical); expect(capture).not.toHaveBeenCalled();
  expect(writes()).toEqual([expect.objectContaining({ label: "Courtyard", refreshed_from: "view", capture: { version: 1, fresh: true } })]);
  fireEvent.click(screen.getByRole("button", { name: "Previous view" }));
  await screen.findByText("Historical geometry / orbit / 400 x 300"); expect(writes()).toHaveLength(1);
});
it("keeps the exact refreshed capture after a saved response followed by a failed library read", async () => {
  views = [{ ...view, historical: true }]; const refresh = vi.fn().mockResolvedValue({ version: 1, fresh: true });
  let reads = 0;
  fetcher.mockImplementation(async (_url, options) => {
    if (options?.body) return Response.json({ id: "fresh" });
    if (++reads === 2) throw new Error("Library offline");
    return Response.json({ views });
  });
  const ui = render(<PlaceViewLibrary sessionId="world" placeId="place" revision={2} capture={capture} refreshView={refresh} disabled={false}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh saved view geometry" }));
  await screen.findByText("Library offline");
  ui.rerender(<PlaceViewLibrary sessionId="world" placeId="place" revision={3} capture={null} refreshView={null} disabled={true}/>);
  fireEvent.click(screen.getByRole("button", { name: "Retry view refresh request" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1]).toEqual(writes()[0]); expect(refresh).toHaveBeenCalledTimes(1);
});
it("discards a refresh rendered against an edited scene before sending any write", async () => {
  views = [{ ...view, historical: true }]; let finish!: (capture: ViewCapture) => void;
  const refresh = vi.fn(() => new Promise<ViewCapture>(resolve => { finish = resolve; }));
  const ui = render(<PlaceViewLibrary sessionId="world" placeId="place" revision={2} capture={capture} refreshView={refresh} disabled={false}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh saved view geometry" }));
  ui.rerender(<PlaceViewLibrary sessionId="world" placeId="place" revision={3} capture={capture} refreshView={refresh} disabled={false}/>);
  await act(async () => finish({ version: 1 } as ViewCapture));
  await screen.findByText("Scene changed while capturing. Refresh again.");
  expect(writes()).toEqual([]);
});
it("blocks fresh recapture of dirty scenes and releases a rejected refresh for a new attempt", async () => {
  views = [{ ...view, historical: true }]; const refresh = vi.fn().mockResolvedValue({ version: 1 });
  const ui = render(<PlaceViewLibrary sessionId="world" placeId="place" revision={2} capture={capture} refreshView={refresh} disabled={true}/>);
  expect((await screen.findByRole("button", { name: "Refresh saved view geometry" }) as HTMLButtonElement).disabled).toBe(true);
  ui.rerender(<PlaceViewLibrary sessionId="world" placeId="place" revision={2} capture={capture} refreshView={refresh} disabled={false}/>);
  fetcher.mockImplementation(async (_url, options) => options?.body ? Response.json({ error: "Stale refresh" }, { status: 409 }) : Response.json({ views }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh saved view geometry" })); await screen.findByText("Stale refresh");
  fireEvent.click(screen.getByRole("button", { name: "Refresh saved view geometry" })); await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(writes()[0].id).not.toBe(writes()[1].id);
});
