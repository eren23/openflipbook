import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import StreetWalkPlayer, { captureStreetEndpoint, type StreetSegment } from "./StreetWalkPlayer";

const segment: StreetSegment = { id: "step-one", request_id: "7c3d797d-8fdd-4bba-b005-dd81d63d28ca", parent_id: null, direction: "forward", status: "ready", video_url: "/api/nodes/street/street-walk/step-one/video", video_sha256: "a".repeat(64), source_sha256: "b".repeat(64), reservation: .4 };
const library = (segments: StreetSegment[] = []) => ({ segments, quote_ceiling_usd: .4, duration_seconds: 5 });
const props = { nodeId: "street", imageUrl: "/api/image/street", title: "Bookshop lane" };
let frames: Map<number, FrameRequestCallback>, nextFrame: number;
beforeEach(() => {
  window.sessionStorage.clear(); frames = new Map(); nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(library())));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
async function open() { fireEvent.click(screen.getByRole("button", { name: "Walk in this street" })); await waitFor(() => expect(screen.getByRole("button", { name: "Check saved steps" }).hasAttribute("disabled")).toBe(false)); }
function decoded(video: HTMLVideoElement, position = 0) {
  let time = position;
  for (const [name, value] of Object.entries({ duration: 5, videoWidth: 128, videoHeight: 72, readyState: 2 })) Object.defineProperty(video, name, { configurable: true, value });
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (value: number) => { time = value; queueMicrotask(() => video.dispatchEvent(new Event("seeked"))); } });
  fireEvent.loadedMetadata(video);
  return video;
}
async function tick(time: number) { await act(async () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(time); }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const firstSaved: StreetSegment = { ...segment, end_frame_url: "/end-one.png", end_frame_sha256: "c".repeat(64) };
const secondSaved: StreetSegment = { ...segment, id: "step-two", request_id: "97d09d16-134c-483b-aa88-e47d0b5c42a2", parent_id: firstSaved.id, video_url: "/api/nodes/street/street-walk/step-two/video", source_sha256: "c".repeat(64), end_frame_url: "/end-two.png", end_frame_sha256: "d".repeat(64) };
async function selectVideo(id: string) { await waitFor(() => expect(screen.getByTestId("street-walk-video").getAttribute("data-segment-id")).toBe(id)); return screen.getByTestId("street-walk-video") as HTMLVideoElement; }

it("submits only an explicit priced step, retaining its fixed request ID before submission", async () => {
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(JSON.parse(window.sessionStorage.getItem("openflipbook.street-walk.pending.street")!)).toEqual(body);
      return Response.json({ segment: { ...segment, id: body.request_id, request_id: body.request_id } });
    }
    return Response.json(library());
  });
  render(<StreetWalkPlayer {...props}/>); await open();
  fireEvent.keyDown(window, { key: "w" }); fireEvent.keyUp(window, { key: "w" }); expect(posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Generate forward step — up to $0.40" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/), direction: "forward", parent_id: null });
});
it("retains an ambiguous request across reload and recovers its acknowledged server alias without posting again", async () => {
  let saved: StreetSegment[] = [];
  vi.mocked(fetch).mockImplementation(async (_url, init) => { if (init?.method === "POST") throw new Error("Lost acknowledgement"); return Response.json(library(saved)); });
  const ui = render(<StreetWalkPlayer {...props}/>); await open();
  fireEvent.click(screen.getByRole("button", { name: "Generate forward step — up to $0.40" }));
  await screen.findByRole("alert");
  const receipt = JSON.parse(window.sessionStorage.getItem("openflipbook.street-walk.pending.street")!);
  expect(posts()).toHaveLength(1); expect(screen.getByRole("button", { name: "Generate forward step — up to $0.40" }).hasAttribute("disabled")).toBe(true);
  ui.unmount(); saved = [{ ...segment, request_ids: [receipt.request_id] }]; render(<StreetWalkPlayer {...props}/>); await open();
  await screen.findByTestId("street-walk-video");
  expect(posts()).toHaveLength(1); expect(window.sessionStorage.getItem("openflipbook.street-walk.pending.street")).toBeNull();
});
it("held forward resumes the current playhead, release/Space/blur pause, and reverse seeks only the saved clip", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(library([segment])));
  render(<StreetWalkPlayer {...props}/>); await open(); const video = decoded(await screen.findByTestId("street-walk-video") as HTMLVideoElement, 2);
  fireEvent.keyDown(window, { key: "w" }); expect(video.play).toHaveBeenCalled(); expect(video.currentTime).toBe(2);
  fireEvent.keyUp(window, { key: "w" }); expect(video.pause).toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "s" }); await tick(100); await tick(200); expect(video.currentTime).toBeCloseTo(1.95); fireEvent.keyUp(window, { key: "s" });
  fireEvent.keyDown(window, { key: "w" }); fireEvent.keyDown(window, { key: " " }); expect(screen.getByRole("status").textContent).toMatch(/Paused/);
  fireEvent.keyDown(window, { key: "w" }); fireEvent.blur(window); expect(screen.getByRole("status").textContent).toMatch(/Paused/);
  expect(posts()).toHaveLength(0); expect(video.loop).toBe(false);
});
it("resumes a paused partial clip in its last milliseconds so the real ended event remains reachable", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(library([segment])));
  render(<StreetWalkPlayer {...props}/>); await open(); const video = decoded(await screen.findByTestId("street-walk-video") as HTMLVideoElement, 4.98);
  fireEvent.keyDown(window, { key: "w" }); expect(video.play).toHaveBeenCalled(); expect(video.currentTime).toBe(4.98);
  fireEvent.keyUp(window, { key: "w" }); expect(screen.getByRole("button", { name: "Continue walking — up to $0.40" }).hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(window, { key: "w" }); expect(vi.mocked(video.play).mock.calls.length).toBe(2); expect(posts()).toHaveLength(0);
});
it("releases a held key even when focus changed to a text field", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(library([segment])));
  render(<><StreetWalkPlayer {...props}/><input aria-label="Other input"/></>); await open(); decoded(await screen.findByTestId("street-walk-video") as HTMLVideoElement, 1);
  fireEvent.keyDown(window, { key: "w" }); fireEvent.keyUp(screen.getByRole("textbox"), { key: "w", ctrlKey: true });
  expect(screen.getByRole("status").textContent).toMatch(/Paused/); expect(posts()).toHaveLength(0);
});
it("touch release and pointer cancellation stop movement without a generation request", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(library([segment])));
  render(<StreetWalkPlayer {...props}/>); await open(); const video = decoded(await screen.findByTestId("street-walk-video") as HTMLVideoElement, 1);
  const forward = screen.getByRole("button", { name: "Forward (hold)" });
  fireEvent.pointerDown(forward, { pointerId: 7 }); expect(video.play).toHaveBeenCalled(); fireEvent.pointerCancel(forward, { pointerId: 7 });
  expect(screen.getByRole("status").textContent).toMatch(/Paused/); expect(posts()).toHaveLength(0);
});
it("held W crosses a saved forward boundary from its real start and stops at the first missing edge without a POST", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json(library([firstSaved, secondSaved])));
  render(<StreetWalkPlayer {...props}/>); await open();
  fireEvent.click(screen.getByRole("button", { name: "Step 1 · forward" })); const first = decoded(await selectVideo(firstSaved.id));
  fireEvent.click(screen.getByRole("button", { name: "Replay this step" })); fireEvent.keyDown(window, { key: "w" });
  first.currentTime = 5; fireEvent.ended(first); const second = decoded(await selectVideo(secondSaved.id));
  expect(second.currentTime).toBe(0); expect(screen.getByRole("status").textContent).toBe("Walking forward"); expect(second.play).toHaveBeenCalledTimes(2);
  second.currentTime = 5; fireEvent.ended(second);
  expect(screen.getByRole("status").textContent).toMatch(/At the saved endpoint/); expect(screen.getByRole("button", { name: "Continue walking — up to $0.40" }).hasAttribute("disabled")).toBe(false);
  expect(posts()).toHaveLength(0); expect(window.sessionStorage.getItem("openflipbook.street-walk.pending.street")).toBeNull();
});
it("held S crosses a saved parent boundary at its decoded endpoint and continues backwards for free", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json(library([firstSaved, secondSaved])));
  render(<StreetWalkPlayer {...props}/>); await open(); const second = decoded(await selectVideo(secondSaved.id));
  fireEvent.keyDown(window, { key: "s" }); second.currentTime = 0; await tick(100);
  const first = decoded(await selectVideo(firstSaved.id)); expect(first.currentTime).toBeCloseTo(5 - 1 / 30);
  await tick(200); await tick(300); expect(first.currentTime).toBeCloseTo(5 - 1 / 30 - .05);
  expect(screen.getByRole("status").textContent).toMatch(/Moving back/); fireEvent.keyUp(window, { key: "s" });
  const paused = first.currentTime; await tick(400); expect(first.currentTime).toBe(paused); expect(posts()).toHaveLength(0);
});
it.each(["release", "blur"])("%s during a saved boundary load cancels the hold without jumping to the child's endpoint", async (reason) => {
  vi.mocked(fetch).mockImplementation(async () => Response.json(library([firstSaved, secondSaved])));
  render(<StreetWalkPlayer {...props}/>); await open(); fireEvent.click(screen.getByRole("button", { name: "Step 1 · forward" }));
  const first = decoded(await selectVideo(firstSaved.id)); fireEvent.click(screen.getByRole("button", { name: "Replay this step" })); fireEvent.keyDown(window, { key: "w" });
  first.currentTime = 5; fireEvent.ended(first); const second = await selectVideo(secondSaved.id);
  if (reason === "release") fireEvent.keyUp(window, { key: "w" }); else fireEvent.blur(window);
  const playCount = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length; decoded(second);
  expect(second.currentTime).toBe(0); expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(playCount);
  expect(screen.getByRole("status").textContent).toMatch(/Paused/); expect(posts()).toHaveLength(0);
});
it("manual saved-step selection stops a held traversal instead of carrying input into another branch", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json(library([firstSaved, secondSaved])));
  render(<StreetWalkPlayer {...props}/>); await open(); decoded(await selectVideo(secondSaved.id));
  fireEvent.click(screen.getByRole("button", { name: "Replay this step" })); fireEvent.keyDown(window, { key: "w" });
  fireEvent.click(screen.getByRole("button", { name: "Step 1 · forward" })); const playCount = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
  decoded(await selectVideo(firstSaved.id)); expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(playCount);
  expect(screen.getByRole("status").textContent).toMatch(/At the saved endpoint/); expect(posts()).toHaveLength(0);
});
it("a late new-step acknowledgement cannot replace a manual saved-path selection", async () => {
  const ack = deferred<Response>(); let saved = [firstSaved, secondSaved];
  vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "POST" ? ack.promise : Response.json(library(saved)));
  render(<StreetWalkPlayer {...props}/>); await open(); decoded(await selectVideo(secondSaved.id));
  fireEvent.click(screen.getByRole("button", { name: "Turn left — up to $0.40" }));
  const request = JSON.parse(String(posts()[0]![1]!.body)); fireEvent.click(screen.getByRole("button", { name: "Step 1 · forward" })); decoded(await selectVideo(firstSaved.id));
  const turn: StreetSegment = { ...secondSaved, id: request.request_id, request_id: request.request_id, parent_id: secondSaved.id, direction: "left" }; saved = [...saved, turn];
  await act(async () => ack.resolve(Response.json({ segment: turn })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check saved steps" }).hasAttribute("disabled")).toBe(false));
  expect(screen.getByTestId("street-walk-video").getAttribute("data-segment-id")).toBe(firstSaved.id); expect(posts()).toHaveLength(1);
});
it.each(["left", "right"] as const)("a saved %s branch is labelled free and opens at its start without a UUID or POST", async (direction) => {
  const turn: StreetSegment = { ...secondSaved, direction }; const uuid = vi.spyOn(crypto, "randomUUID");
  vi.mocked(fetch).mockImplementation(async () => Response.json(library([firstSaved, turn])));
  render(<StreetWalkPlayer {...props}/>); await open(); fireEvent.click(screen.getByRole("button", { name: "Step 1 · forward" })); decoded(await selectVideo(firstSaved.id));
  fireEvent.click(screen.getByRole("button", { name: `Take saved ${direction} turn — free` })); const video = decoded(await selectVideo(turn.id));
  expect(video.currentTime).toBe(0); expect(video.play).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0); expect(uuid).not.toHaveBeenCalled();
});
it("does not cross a saved edge whose source hash disagrees with the acknowledged parent frame", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json(library([firstSaved, { ...secondSaved, source_sha256: "e".repeat(64) }])));
  render(<StreetWalkPlayer {...props}/>); await open(); fireEvent.click(screen.getByRole("button", { name: "Step 1 · forward" })); const first = decoded(await selectVideo(firstSaved.id));
  expect(screen.queryByRole("button", { name: "Walk saved forward step — free" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Replay this step" })); fireEvent.keyDown(window, { key: "w" }); first.currentTime = 5; fireEvent.ended(first);
  expect(screen.getByTestId("street-walk-video").getAttribute("data-segment-id")).toBe(firstSaved.id); expect(posts()).toHaveLength(0);
});
it("blocks continuation at a partial playhead and saves only the decoded completed frame before a turn", async () => {
  const draw = vi.fn(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA==");
  let saved = [segment];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (init?.method === "POST" && String(url).endsWith("/frame")) { saved = [{ ...segment, end_frame_url: "/saved-end.png" }]; return Response.json({ end_frame_url: "/saved-end.png", sha256: "c".repeat(64) }); }
    if (init?.method === "POST") { const body = JSON.parse(String(init.body)); return Response.json({ segment: { ...segment, id: body.request_id, request_id: body.request_id, direction: body.direction, parent_id: body.parent_id } }); }
    return Response.json(library(saved));
  });
  render(<StreetWalkPlayer {...props}/>); await open(); const video = decoded(await screen.findByTestId("street-walk-video") as HTMLVideoElement, 2);
  expect(screen.getByRole("button", { name: "Turn left — up to $0.40" }).hasAttribute("disabled")).toBe(true); expect(posts()).toHaveLength(0);
  video.currentTime = 5; fireEvent.ended(video);
  await waitFor(() => expect(screen.getByRole("button", { name: "Turn left — up to $0.40" }).hasAttribute("disabled")).toBe(false));
  expect(draw).toHaveBeenCalledWith(video, 0, 0, 128, 72);
  expect(JSON.parse(String(posts()[0]![1]!.body))).toMatchObject({ image_data_url: "data:image/png;base64,AA==", video_sha256: segment.video_sha256, time_seconds: 5 - 1 / 30, duration_seconds: 5 });
  fireEvent.click(screen.getByRole("button", { name: "Turn left — up to $0.40" }));
  await waitFor(() => expect(posts()).toHaveLength(2)); expect(JSON.parse(String(posts()[1]![1]!.body))).toMatchObject({ parent_id: "step-one", direction: "left" });
});
it("a saved endpoint cannot seed another step after replay or reverse moved away from it", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(library([{ ...segment, end_frame_url: "/saved-end.png" }])));
  render(<StreetWalkPlayer {...props}/>); await open(); decoded(await screen.findByTestId("street-walk-video") as HTMLVideoElement);
  expect(screen.getByRole("button", { name: "Continue walking — up to $0.40" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Replay this step" }));
  expect(screen.getByRole("button", { name: "Continue walking — up to $0.40" }).hasAttribute("disabled")).toBe(true);
  expect(posts()).toHaveLength(0);
});
it("unmount preserves a submitted request ID and late completion cannot start another request", async () => {
  const ack = deferred<Response>();
  vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "POST" ? ack.promise : Response.json(library()));
  const ui = render(<StreetWalkPlayer {...props}/>); await open(); fireEvent.click(screen.getByRole("button", { name: "Generate forward step — up to $0.40" }));
  const receipt = JSON.parse(window.sessionStorage.getItem("openflipbook.street-walk.pending.street")!); ui.unmount();
  await act(async () => ack.resolve(Response.json({ segment: { ...segment, request_id: receipt.request_id } })));
  expect(JSON.parse(window.sessionStorage.getItem("openflipbook.street-walk.pending.street")!)).toEqual(receipt); expect(posts()).toHaveLength(1);
});
it("an exact ready GET receipt resolves a hanging POST so saved endpoint continuation can proceed", async () => {
  const ack = deferred<Response>(); let saved: StreetSegment[] = [];
  vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "POST" ? ack.promise : Response.json(library(saved)));
  const ui = render(<StreetWalkPlayer {...props}/>); await open(); fireEvent.click(screen.getByRole("button", { name: "Generate forward step — up to $0.40" }));
  const receipt = JSON.parse(window.sessionStorage.getItem("openflipbook.street-walk.pending.street")!);
  saved = [{ ...segment, status: "submitting", video_url: null, request_ids: [receipt.request_id] }]; fireEvent.click(screen.getByRole("button", { name: "Check saved steps" }));
  await waitFor(() => expect(window.sessionStorage.getItem("openflipbook.street-walk.pending.street")).toBeNull());
  await waitFor(() => expect(screen.getByRole("button", { name: "Check saved steps" }).hasAttribute("disabled")).toBe(false));
  saved = [{ ...segment, request_ids: [receipt.request_id], end_frame_url: "/saved-end.png" }]; fireEvent.click(screen.getByRole("button", { name: "Check saved steps" }));
  decoded(await screen.findByTestId("street-walk-video") as HTMLVideoElement);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue walking — up to $0.40" }).hasAttribute("disabled")).toBe(false));
  expect(posts()).toHaveLength(1); ui.unmount(); await act(async () => ack.resolve(Response.json({ segment: saved[0] })));
});
it("blocks new steps while a server submission is unresolved or its local receipt is unreadable", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(library([{ ...segment, status: "submission_unknown", video_url: null }])));
  const ui = render(<StreetWalkPlayer {...props}/>); await open();
  expect(screen.getByRole("button", { name: "Continue walking — up to $0.40" }).hasAttribute("disabled")).toBe(true);
  ui.unmount(); window.sessionStorage.setItem("openflipbook.street-walk.pending.street", "invalid-json"); vi.mocked(fetch).mockResolvedValue(Response.json(library()));
  render(<StreetWalkPlayer {...props}/>); await open(); expect(screen.getByRole("button", { name: "Generate forward step — up to $0.40" }).hasAttribute("disabled")).toBe(true); expect(posts()).toHaveLength(0);
});
it.each(["storage_failed", "submission_unknown"])("explicitly recovers %s for free with its exact original ID and no new UUID", async status => {
  const retained = { ...segment, status, provider_request_id: "provider-known", video_url: null };
  vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "POST" ? Response.json({ segment: retained }) : Response.json(library([retained])));
  const uuid = vi.spyOn(crypto, "randomUUID"); render(<StreetWalkPlayer {...props}/>); await open();
  fireEvent.click(screen.getByRole("button", { name: "Recover saved step — $0" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]![0]).toBe("/api/nodes/street/street-walk");
  expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ request_id: segment.request_id, parent_id: null, direction: "forward" }); expect(uuid).not.toHaveBeenCalled();
});
it("does not offer submission recovery without a saved provider ID", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(library([{ ...segment, status: "submission_unknown", video_url: null, provider_request_id: null }])));
  render(<StreetWalkPlayer {...props}/>); await open(); expect(screen.queryByRole("button", { name: "Recover saved step — $0" })).toBeNull(); expect(posts()).toHaveLength(0);
});
it("last-frame capture requires a decoded video and retains its native pixel dimensions", async () => {
  const video = document.createElement("video"); await expect(captureStreetEndpoint(video)).rejects.toThrow("not decoded");
  const draw = vi.fn(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA=="); decoded(video, 5 - 1 / 30);
  const frame = await captureStreetEndpoint(video); expect(draw).toHaveBeenCalledWith(video, 0, 0, 128, 72); expect(frame.duration_seconds).toBe(5); expect(frame.time_seconds).toBeCloseTo(4.966666667);
});

it("stays hidden unless NEXT_PUBLIC_STREET_WALK is set", async () => {
  const enabled = async (value: string) => { vi.resetModules(); vi.stubEnv("NEXT_PUBLIC_STREET_WALK", value); return (await import("./StreetWalkPlayer")).STREET_WALK_ENABLED; };
  expect(await enabled("")).toBe(false);
  expect(await enabled("1")).toBe(true);
  vi.unstubAllEnvs();
});
