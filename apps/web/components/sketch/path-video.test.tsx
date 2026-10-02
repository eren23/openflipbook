import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PathVideo from "./path-video";
const job = { id: "walk", status: "ready", reservation: 1.4, committed: 1.4, created_at: "", media: { width: 64, height: 32 },
  keyframes: [{ time: 0, stage: "source", status: "ready" }, { time: 1, stage: "chain", status: "ready", gate: "failed", passed: false }],
  legs: [{ seconds: 6, duration: 8, landed: false, attempts: [{ status: "ready", land: 1, snap: 2, ok: false }, { status: "ready", land: .5, snap: 3, ok: false }] }] };
const base = { study_sha256: "frozen", checkpoints: 2, reason: "", jobs: [job], quote: { reservation: .74, paid_keyframes: 1, keyframe_reservation: .1, legs: [{ seconds: 6, duration: 8, reservation: .64 }] } };
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
