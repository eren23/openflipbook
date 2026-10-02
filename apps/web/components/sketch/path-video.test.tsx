import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PathVideo, { WalkVideo } from "./path-video";
import type { ViewCapture } from "@/lib/place-view";
const job = { id: "walk", status: "ready", reservation: 1.4, committed: 1.4, created_at: "", media: { width: 64, height: 32 },
  keyframes: [{ time: 0, stage: "source", status: "ready" }, { time: 1, stage: "chain", status: "ready", gate: "failed", passed: false }],
  legs: [{ seconds: 6, duration: 8, landed: false, attempts: [{ status: "ready", land: 1, snap: 2, ok: false }, { status: "ready", land: .5, snap: 3, ok: false }] }] };
const base = { study_sha256: "frozen", checkpoints: 2, reason: "", jobs: [job], quote: { reservation: .74, paid_keyframes: 1, appearance: true, keyframe_reservation: .1, legs: [{ seconds: 6, duration: 8, reservation: .64 }] } };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json(base))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
  fireEvent.click(screen.getByRole("checkbox", { name: "Reserve $0.74 for 1 keyframes and 1 legs" }));
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
  const consent = screen.getByRole("checkbox", { name: "Reserve $0.74 for 1 keyframes and 1 legs" }) as HTMLInputElement;
  await waitFor(() => { if (!consent.checked) fireEvent.click(consent); expect((generate as HTMLButtonElement).disabled).toBe(false); });
});
it("makes a walk video: a saved checkpoint view at each eye pose of the route, then one priced job over them", async () => {
  const empty = { views_sha256: "", checkpoints: 0, quote: null, reason: "", jobs: [] };
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    // Checkpoint 2 matches a checkpoint saved before: the server answers with that view's id.
    if (url.endsWith("/places/place/views") && init?.method === "POST") { const view = JSON.parse(String(init.body)); return Response.json({ id: view.label.endsWith("2/3") ? "kept" : view.id }); }
    if (url.includes("/walk-videos?views=")) return Response.json({ ...empty, views_sha256: "pinned", checkpoints: 3,
      quote: { reservation: 1.1, paid_keyframes: 3, appearance: true, keyframe_reservation: .1, legs: [{ seconds: 2.857, duration: 5, reservation: .4 }, { seconds: 2.857, duration: 5, reservation: .4 }] } });
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
  const consent = screen.getByRole("checkbox", { name: "Reserve $1.10 for 3 keyframes and 2 legs" }) as HTMLInputElement;
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
