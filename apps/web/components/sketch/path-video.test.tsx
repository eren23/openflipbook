import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PathVideo, { WalkVideo } from "./path-video";
import type { ViewCapture } from "@/lib/place-view";
const job = { id: "walk", status: "ready", reservation: 1.4, committed: 1.4, created_at: "", media: { width: 64, height: 32 },
  keyframes: [{ time: 0, stage: "source", status: "ready" }, { time: 1, stage: "chain", status: "ready", gate: "failed", passed: false }],
  legs: [{ seconds: 6, duration: 8, landed: false, attempts: [{ status: "ready", land: 1, snap: 2, ok: false }, { status: "ready", land: .5, snap: 3, ok: false }] }] };
const base = { study_sha256: "frozen", checkpoints: 2, reason: "", jobs: [job], quote: { reservation: .74, expected_cost: .37, retry_allowance: 1, paid_keyframes: 1, appearance: true, keyframe_reservation: .1, legs: [{ seconds: 6, duration: 8, reservation: .64 }] } };
beforeEach(() => { vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}); vi.stubGlobal("fetch", vi.fn(async () => Response.json(base))); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("stays hidden when the server flag is off", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
  const ui = render(<PathVideo sessionId="world" studyId="study" disabled={false}/>);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await waitFor(() => expect(ui.container.innerHTML).toBe(""));
});
it("shows the quote and per-leg checks, and generates only after a prompt and priced consent", async () => {
  const ui = render(<PathVideo sessionId="world" studyId="study" disabled={false}/>);
  const generate = await screen.findByRole("button", { name: "Generate path video" });
  expect(screen.getByText("2 keyframe checkpoints / 1 legs")).toBeTruthy();
  expect(screen.getByText(/land 0\.50 snap 3\.0/)).toBeTruthy(); expect(screen.getByText("/ did not land")).toBeTruthy();
  expect(ui.container.querySelector("video")!.src).toContain("/api/world/world/motion-studies/study/path-videos/walk/video");
  fireEvent.click(screen.getByRole("checkbox", { name: "Approve up to $0.74 (expected $0.37) for 1 keyframes and 1 legs" }));
  expect((generate as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Path video appearance" }), { target: { value: "Watercolour inn" } });
  fireEvent.click(generate);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === "POST")).toBe(true));
  const write = vi.mocked(fetch).mock.calls.find(call => call[1]?.method === "POST")!;
  expect(JSON.parse(String(write[1]!.body))).toMatchObject({ action: "generate", confirmed: true, prompt: "Watercolour inn", study_sha256: "frozen", reservation: .74 });
});
it("asks no appearance words when every paid keyframe chains from the accepted artwork", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ ...base, quote: { ...base.quote, appearance: false } }));
  render(<PathVideo sessionId="world" studyId="study" disabled={false}/>);
  const generate = await screen.findByRole("button", { name: "Generate path video" });
  expect(screen.queryByRole("textbox")).toBeNull();
  // Consent resets when the quote arrives, so tick it again until it holds.
  const consent = screen.getByRole("checkbox", { name: "Approve up to $0.74 (expected $0.37) for 1 keyframes and 1 legs" }) as HTMLInputElement;
  await waitFor(() => { if (!consent.checked) fireEvent.click(consent); expect((generate as HTMLButtonElement).disabled).toBe(false); });
});
it("makes a walk video: a saved checkpoint view at each eye pose of the route, then one priced job over them", async () => {
  const empty = { views_sha256: "", checkpoints: 0, quote: null, reason: "", jobs: [] };
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    // Checkpoint 2 matches a checkpoint saved before: the server answers with that view's id.
    if (url.endsWith("/places/place/views") && init?.method === "POST") { const view = JSON.parse(String(init.body)); return Response.json({ id: view.label.endsWith("2/3") ? "kept" : view.id }); }
    if (url.includes("/walk-videos?views=")) return Response.json({ ...empty, views_sha256: "pinned", checkpoints: 3,
      quote: { reservation: 1.1, expected_cost: .55, retry_allowance: 1, paid_keyframes: 3, appearance: true, keyframe_reservation: .1, legs: [{ seconds: 2.857, duration: 5, reservation: .4 }, { seconds: 2.857, duration: 5, reservation: .4 }] } });
    if (url.endsWith("/walk-videos") && init?.method === "POST") return Response.json({ job: { id: "walk" } });
    return Response.json(empty);
  });
  const capture = vi.fn((pose?: { x: number; z: number; yaw: number }) => ({ mode: "walk", pose }) as unknown as ViewCapture);
  render(<WalkVideo sessionId="world" placeId="place" route={[{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -8, yaw: 0 }]} capture={capture} disabled={false}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Make walk video" }));
  const generate = await screen.findByRole("button", { name: "Generate walk video" });
  expect(capture.mock.calls.map(([pose]) => [pose!.x, pose!.z, pose!.yaw])).toEqual([[0, 0, 0], [0, -4, 0], [0, -8, 0]]);
  const posts = (suffix: string) => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
  const saved = posts("/places/place/views"), ids = [saved[0].id, "kept", saved[2].id];
  expect(saved.map(view => [view.label, view.walk_checkpoint, view.capture.pose.z])).toEqual([["Walk checkpoint 1/3", true, 0], ["Walk checkpoint 2/3", true, -4], ["Walk checkpoint 3/3", true, -8]]);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith(`/walk-videos?views=${encodeURIComponent(ids.join(","))}`))).toBe(true);
  expect(screen.queryByRole("button", { name: "Make walk video" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Path video appearance" }), { target: { value: "Inked stone" } });
  const consent = screen.getByRole("checkbox", { name: "Approve up to $1.10 (expected $0.55) for 3 keyframes and 2 legs" }) as HTMLInputElement;
  await waitFor(() => { if (!consent.checked) fireEvent.click(consent); expect((generate as HTMLButtonElement).disabled).toBe(false); });
  fireEvent.click(generate);
  await waitFor(() => expect(posts("/walk-videos")).toHaveLength(1));
  expect(posts("/walk-videos")[0]).toMatchObject({ action: "generate", confirmed: true, prompt: "Inked stone", view_ids: ids, views_sha256: "pinned", reservation: 1.1 });
});
it.each([[-60, /16 checkpoints, more than 12/], [0, /at least 2 checkpoints/]])("refuses a walk route to z %s that cannot make a video before saving anything", async (z, message) => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ views_sha256: "", checkpoints: 0, quote: null, reason: "", jobs: [] }));
  const capture = vi.fn(() => ({}) as ViewCapture);
  render(<WalkVideo sessionId="world" placeId="place" route={[{ x: 0, z: 0, yaw: 0 }, { x: 0, z, yaw: 0 }]} capture={capture} disabled={false}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Make walk video" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(message);
  expect(capture).not.toHaveBeenCalled(); expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("opens first-checkpoint review only after every free canonical checkpoint is acknowledged", async () => {
  const held = deferred<Response>(), prepared = vi.fn(); let writes = 0;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith("/views") && init?.method === "POST") {
      writes++;
      return writes === 2 ? held.promise : Response.json({ id: "first" });
    }
    return Response.json({ views_sha256: "", checkpoints: 0, quote: null, reason: "", jobs: [] });
  });
  const capture = vi.fn(() => ({}) as ViewCapture);
  render(<WalkVideo sessionId="world" placeId="place" route={[{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -4, yaw: 0 }]} capture={capture} disabled={false} illustrated onPrepared={prepared}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Make walk video" }));
  await waitFor(() => expect(writes).toBe(2)); expect(prepared).not.toHaveBeenCalled();
  await act(async () => held.resolve(Response.json({ id: "last" })));
  await waitFor(() => expect(prepared).toHaveBeenCalledWith(["first", "last"]));
  const saves = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
  expect(saves[0].walk_checkpoint).toBeUndefined(); expect(saves[1].walk_checkpoint).toBe(true);
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").every(([url]) => String(url).endsWith("/views"))).toBe(true);
});

it("retains the selected walk quote when a previous library request returns late", async () => {
  const old = deferred<Response>();
  vi.mocked(fetch).mockImplementation(async input => String(input).includes("?views=")
    ? Response.json({ ...base, views_sha256: "chosen", study_sha256: undefined }) : old.promise);
  const ui = render(<PathVideo sessionId="world" walk={{ placeId: "place", viewIds: [] }} disabled={false}/>);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  ui.rerender(<PathVideo sessionId="world" walk={{ placeId: "place", viewIds: ["a", "b"] }} disabled={false}/>);
  await screen.findByRole("button", { name: "Generate walk video" });
  await act(async () => old.resolve(new Response(null, { status: 404 })));
  expect(screen.getByRole("button", { name: "Generate walk video" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Chosen source" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /^Approve up to/ }));
  fireEvent.click(screen.getByRole("button", { name: "Generate walk video" }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
  const write = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(write[1]!.body))).toMatchObject({ view_ids: ["a", "b"], views_sha256: "chosen" });
});

it("ignores stale errors and shows saved walks after reload without a route", async () => {
  const old = deferred<Response>();
  vi.mocked(fetch).mockImplementationOnce(() => old.promise).mockImplementation(async () => Response.json({ ...base, quote: null }));
  const ui = render(<WalkVideo sessionId="world" placeId="old" capture={null} disabled={false}/>);
  ui.rerender(<WalkVideo sessionId="world" placeId="place" capture={null} disabled={false}/>);
  await screen.findByText(/ready for review/);
  await act(async () => old.reject(new Error("old request failed")));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Make walk video" })).toBeNull();
  expect(ui.container.querySelector("video")!.src).toContain("/places/place/walk-videos/walk/video");
  ui.unmount();
  const reopened = render(<WalkVideo sessionId="world" placeId="place" capture={null} disabled={false}/>);
  await screen.findByText(/ready for review/);
  expect(reopened.container.querySelector("video")).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
it("reopens the exact prepared chain after reload without recapturing or spending", async () => {
  render(<WalkVideo sessionId="world" placeId="place" initialViewIds={["first","last"]} capture={null} disabled={false}/>);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/walk-videos?views=first%2Clast"))).toBe(true));
  expect(screen.queryByRole("button",{name:"Make walk video"})).toBeNull();
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});
it("chooses accepted-only explicitly and retains the same two-anchor quote and request across a lost acknowledgement", async () => {
  const writes: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === "POST") { writes.push(String(init.body)); if (writes.length === 1) throw new Error("Lost ACK"); return Response.json({ saved: true }); }
    return Response.json({ ...base, views_sha256: "camera-pins", accepted_anchors_sha256: "a".repeat(64), quote: String(input).includes("accepted-only-v1")
      ? { reservation: .4, expected_cost: .4, retry_allowance: 0, paid_keyframes: 0, appearance: false, keyframe_reservation: 0, legs: [{ seconds: 5, duration: 5, reservation: .4 }] }
      : base.quote });
  });
  render(<PathVideo sessionId="world" walk={{ placeId: "place", viewIds: ["first", "last"] }} disabled={false}/>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Use only the two accepted artworks (no new images)" }));
  const consent = await screen.findByRole("checkbox", { name: "Approve up to $0.40 (expected $0.40) for 0 keyframes and 1 legs" });
  expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText(/Includes up to one consistency retry/)).toBeNull();
  fireEvent.click(consent); fireEvent.click(screen.getByRole("button", { name: "Generate walk video" }));
  await screen.findByText("Lost ACK");
  expect(screen.getByRole("checkbox", { name: "Use only the two accepted artworks (no new images)" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry same walk video request" })); await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toBe(writes[0]);
  expect(JSON.parse(writes[0]!)).toMatchObject({ keyframe_policy: "accepted-only-v1", view_ids: ["first", "last"], views_sha256: "camera-pins", accepted_anchors_sha256: "a".repeat(64), reservation: .4 });
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("?views=first%2Clast&keyframe_policy=accepted-only-v1"))).toBe(true);
});
it("replaces the first-art quote and clears previous consent after acceptance without resubmitting", async () => {
  let accepted = false;
  vi.mocked(fetch).mockImplementation(async () => Response.json({ ...base, views_sha256: accepted ? "accepted-art" : "old-art",
    quote: { ...base.quote, appearance: !accepted, reservation: accepted ? .54 : .74, expected_cost: accepted ? .27 : .37, paid_keyframes: accepted ? 0 : 1 } }));
  const ui=render(<WalkVideo sessionId="world" placeId="place" initialViewIds={["first","last"]} capture={null} disabled={false}/>);
  await screen.findByRole("button",{name:"Generate walk video"});
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"Existing painting"}});fireEvent.click(screen.getByRole("checkbox", { name: /^Approve up to/ }));
  accepted=true;ui.rerender(<WalkVideo sessionId="world" placeId="place" initialViewIds={["first","last"]} capture={null} disabled={false} refreshKey={1}/>);
  const consent=await screen.findByRole("checkbox",{name:"Approve up to $0.54 (expected $0.27) for 0 keyframes and 1 legs"});
  expect(consent).toHaveProperty("checked",false);expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("button",{name:"Generate walk video"})).toHaveProperty("disabled",true);
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});

it("retries a lost generate acknowledgement with identical approved bytes", async () => {
  const writes: string[] = [];
  vi.mocked(fetch).mockImplementation(async (_input, init) => {
    if (init?.method === "POST") {
      writes.push(String(init.body));
      if (writes.length === 1) throw new Error("Acknowledgement lost");
      return Response.json({ job: { id: "saved" } });
    }
    return Response.json(base);
  });
  render(<PathVideo sessionId="world" studyId="study" disabled={false}/>);
  await screen.findByRole("button", { name: "Generate path video" });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Accepted source" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Generate path video" }));
  await screen.findByText("Acknowledgement lost");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Changed after submission" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry same path video request" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toBe(writes[0]);
  expect(JSON.parse(writes[1]!).prompt).toBe("Accepted source");
});

const resumeQuote = { expected_cost: .25, reservation: .5, retry_allowance: 1, source_sha256: "source", job_sha256: "reviewed" };
const paused = { ...base, quote: null, jobs: [{ ...job, status: "needs_review", error: "Consistency retry failed", media: undefined, resume_quote: resumeQuote }] };
it("preserves a paused job and resumes only with fresh quoted consent; acknowledgement retries retain the request id", async () => {
  const writes: string[] = [];
  vi.mocked(fetch).mockImplementation(async (_input, init) => {
    if (init?.method === "POST") {
      writes.push(String(init.body));
      if (writes.length === 1) throw new Error("Resume acknowledgement lost");
      return Response.json({ job: { id: "walk" } });
    }
    return Response.json(paused);
  });
  render(<PathVideo sessionId="world" studyId="study" disabled={false}/>);
  const resume = await screen.findByRole("button", { name: "Resume path video" });
  expect(screen.getByText(/paused for review/)).toBeTruthy();
  expect(screen.getByText(/route and completed work are preserved/)).toBeTruthy();
  expect((resume as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Resume walk: approve up to \$0.50 \(expected \$0.25\)/ }));
  fireEvent.click(resume);
  await screen.findByText("Resume acknowledgement lost");
  fireEvent.click(screen.getByRole("button", { name: "Retry same resume request" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toBe(writes[0]);
  expect(JSON.parse(writes[1]!)).toMatchObject({ action: "resume", id: "walk", confirmed: true, reservation: .5, source_sha256: "source", job_sha256: "reviewed", request_id: expect.any(String) });
});

it("invalidates resume consent when the server changes the preserved source or job hash", async () => {
  let snapshot = paused;
  vi.mocked(fetch).mockImplementation(async () => Response.json(snapshot));
  render(<PathVideo sessionId="world" studyId="study" disabled={false}/>);
  const resume = await screen.findByRole("button", { name: "Resume path video" });
  fireEvent.click(screen.getByRole("checkbox"));
  expect((resume as HTMLButtonElement).disabled).toBe(false);
  snapshot = { ...paused, jobs: [{ ...paused.jobs[0]!, resume_quote: { ...resumeQuote, job_sha256: "changed" } }] };
  fireEvent.click(screen.getByRole("button", { name: "Refresh path videos" }));
  await waitFor(() => expect((resume as HTMLButtonElement).disabled).toBe(true));
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
});

it("adds free saved-walk controls only to walk jobs and preserves native motion-study playback", async () => {
  const ui = render(<PathVideo sessionId="world" walk={{ placeId: "place", viewIds: [] }} disabled={false}/>);
  await screen.findByRole("region", { name: "Saved walk playback" });
  expect(screen.getByRole("link", { name: "Open map" }).getAttribute("href")).toBe("/sketch/world?world=world&place=place&view=plan");
  expect(ui.container.querySelector("video")!.controls).toBe(true);
  ui.rerender(<PathVideo sessionId="world" studyId="study" disabled={false}/>); await screen.findByRole("button", { name: "Generate path video" });
  expect(screen.queryByRole("region", { name: "Saved walk playback" })).toBeNull(); expect(ui.container.querySelector("video")!.controls).toBe(true);
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
});
it("prepares every illustrated route checkpoint as ordinary artwork-review views and preserves lost-ACK bodies", async () => {
  const saved: string[] = []; let loseAck = true;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith("/views") && init?.method === "POST") { saved.push(String(init.body)); if (saved.length === 2 && loseAck) { loseAck = false; throw Error("Camera ACK lost"); } return Response.json({ id: JSON.parse(String(init.body)).id }); }
    return Response.json({ views_sha256: "", checkpoints: 0, quote: null, reason: "", jobs: [] });
  });
  const capture = vi.fn((pose: unknown) => ({ pose }) as unknown as ViewCapture);
  render(<WalkVideo sessionId="world" placeId="place" route={[{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -8, yaw: 0 }]} capture={capture} disabled={false} illustrated/>);
  const option = await screen.findByRole("checkbox", { name: "Review artwork at every checkpoint (free camera saves)" }); fireEvent.click(option); fireEvent.click(screen.getByRole("button", { name: "Make walk video" }));
  await screen.findByText("Camera ACK lost"); expect(option).toHaveProperty("disabled", true); fireEvent.click(screen.getByRole("button", { name: "Retry walk checkpoints" }));
  await waitFor(() => expect(saved).toHaveLength(5)); expect(saved[2]).toBe(saved[0]); expect(saved[3]).toBe(saved[1]);
  expect(saved.map(body => JSON.parse(body).walk_checkpoint)).toEqual([undefined, undefined, undefined, undefined, undefined]); expect(capture).toHaveBeenCalledTimes(3);
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").every(([url]) => String(url).endsWith("/views"))).toBe(true);
});
it("uses the exact reviewed-route policy and ordered anchor hash only after server quote and priced consent", async () => {
  const writes: string[] = [], ids = ["first", "middle", "last"], anchors = "b".repeat(64), routeQuote = { reservation: .8, expected_cost: .8, retry_allowance: 0, paid_keyframes: 0, appearance: false, keyframe_reservation: 0, legs: [{ seconds: 5, duration: 5, reservation: .4 }, { seconds: 5, duration: 5, reservation: .4 }] };
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === "POST") { writes.push(String(init.body)); return Response.json({ job: { id: "route" } }); }
    return Response.json({ ...base, study_sha256: undefined, views_sha256: "route-cameras", accepted_anchors_sha256: anchors, checkpoints: 3, quote: String(input).includes("keyframe_policy=accepted-route-v1") ? routeQuote : null });
  });
  render(<PathVideo sessionId="world" walk={{ placeId: "place", viewIds: ids }} disabled={false}/>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Use only the reviewed route artworks (no new images)" }));
  const consent = await screen.findByRole("checkbox", { name: "Approve up to $0.80 (expected $0.80) for 0 keyframes and 2 legs" }), generate = screen.getByRole("button", { name: "Generate walk video" });
  expect(generate).toHaveProperty("disabled", true); expect(screen.queryByRole("textbox")).toBeNull(); fireEvent.click(consent); fireEvent.click(generate);
  await waitFor(() => expect(writes).toHaveLength(1)); expect(JSON.parse(writes[0]!)).toMatchObject({ keyframe_policy: "accepted-route-v1", accepted_anchors_sha256: anchors, view_ids: ids, views_sha256: "route-cameras", reservation: .8 });
});
it("does not assume selected route cameras have reviewed artworks when the server returns no quote", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ ...base, checkpoints: 3, quote: null, reason: "Review and accept every route artwork first" }));
  render(<PathVideo sessionId="world" walk={{ placeId: "place", viewIds: ["a", "b", "c"] }} disabled={false}/>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Use only the reviewed route artworks (no new images)" }));
  await screen.findByText("Review and accept every route artwork first"); expect(screen.queryByRole("button", { name: "Generate walk video" })).toBeNull();
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
});
it("automatically waits for reviewed artworks after full-route camera preparation and consumes that preference once", async () => {
  const capture = vi.fn(() => ({}) as ViewCapture), route = [{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -8, yaw: 0 }];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith("/views") && init?.method === "POST") return Response.json({ id: JSON.parse(String(init.body)).id });
    if (String(input).includes("accepted-route-v1")) return Response.json({ views_sha256: "current", checkpoints: 3, quote: null, jobs: [], reason: "Camera 3 needs reviewed artwork" });
    return Response.json({ ...base, checkpoints: String(input).includes("?views=") ? 3 : 0 });
  });
  const ui = render(<WalkVideo sessionId="world" placeId="place" route={route} capture={capture} disabled={false} illustrated/>);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Review artwork at every checkpoint (free camera saves)" })); fireEvent.click(screen.getByRole("button", { name: "Make walk video" }));
  await screen.findByText("Camera 3 needs reviewed artwork");
  const policy = screen.getByRole("checkbox", { name: "Use only the reviewed route artworks (no new images)" }); expect(policy).toHaveProperty("checked", true);
  expect(screen.queryByRole("button", { name: "Generate walk video" })).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull();
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").every(([url]) => String(url).endsWith("/views"))).toBe(true);
  fireEvent.click(policy); await screen.findByRole("textbox", { name: "Path video appearance" }); expect(policy).toHaveProperty("checked", false);
  ui.rerender(<WalkVideo sessionId="world" placeId="place" route={route} capture={capture} disabled={false} illustrated refreshKey={1}/>);
  await screen.findByRole("textbox", { name: "Path video appearance" }); expect(policy).toHaveProperty("checked", false);
});
