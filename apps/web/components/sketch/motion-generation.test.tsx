import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MotionGeneration from "./motion-generation";
import { motionStudyFixture } from "@/tests/fixtures/motion-study";
import { motionComparisonPlan } from "@/lib/motion-comparison";
const base = { jobs: [], assets: [], reviews: [], comparison: { sha256: "frozen-plan", plan: motionComparisonPlan(motionStudyFixture()) }, accepted_id: null, study_sha256: "frozen-study", historical: false, reason: "",
  quote: { model: "h3", adapter: "hypothesis", reservation: .48 } };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json(base))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("requires both price and experimental mapping consent without automatic writes", async () => {
  render(<MotionGeneration sessionId="world" studyId="study" disabled={false} onTime={() => {}}/>);
  const generate = await screen.findByRole("button", { name: "Generate calibration clip" });
  expect((generate as HTMLButtonElement).disabled).toBe(true);
  // Flush the consent reset the library load scheduled. Under a loaded run it
  // otherwise lands at the end of the first click's act() and unticks it.
  await act(async () => {});
  fireEvent.click(screen.getByRole("checkbox", { name: "Reserve $0.48 for this clip" }));
  expect((generate as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Use experimental camera mapping" }));
  expect((generate as HTMLButtonElement).disabled).toBe(false);
  expect(vi.mocked(fetch).mock.calls.every(call => call[1]?.method !== "POST")).toBe(true);
});
it("shows the full quoted reservation instead of rounding away fractional cents", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...base, quote: { ...base.quote, reservation: .480006 } }));
  render(<MotionGeneration sessionId="world" studyId="study" disabled={false} onTime={() => {}}/>);
  await screen.findByRole("checkbox", { name: "Reserve $0.480006 for this clip" });
});
it("retries a lost response with identical consent, identity and price after the quote changes", async () => {
  let lost = false;
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    if (options?.method === "POST") { if (!lost) { lost = true; throw new Error("Response lost"); } return Response.json({ job: {} }); }
    return Response.json({ ...base, quote: { ...base.quote, reservation: lost ? .64 : .48 } });
  });
  render(<MotionGeneration sessionId="world" studyId="study" disabled={false} onTime={() => {}}/>);
  await screen.findByRole("button", { name: "Generate calibration clip" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Reserve $0.48 for this clip" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Use experimental camera mapping" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate calibration clip" }));
  await screen.findByText("Response lost");
  fireEvent.click(screen.getByRole("button", { name: "Refresh motion jobs" }));
  await screen.findByRole("checkbox", { name: "Reserve $0.64 for this clip" });
  fireEvent.click(screen.getByRole("button", { name: "Retry same motion request" }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(2));
  const writes = vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === "POST");
  expect(writes[0]![1]!.body).toBe(writes[1]![1]!.body);
  expect(JSON.parse(String(writes[1]![1]!.body))).toMatchObject({ reservation: .48, confirmed: true, calibration_confirmed: true, study_sha256: "frozen-study", comparison_sha256: "frozen-plan" });
});
it("loads private silent clips without accepting them and synchronizes reference time", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...base, quote: null, assets: [{ id: "clip", historical: false, duration_matches: true, media: { width: 128, height: 96 } }] }));
  const onTime = vi.fn(); const ui = render(<MotionGeneration sessionId="world" studyId="study" disabled={false} onTime={onTime}/>);
  expect((await screen.findByRole("button", { name: "Accept reviewed clip" }) as HTMLButtonElement).disabled).toBe(true);
  const video = ui.container.querySelector("video")!;
  expect(video.src).toContain("/api/world/world/motion-studies/study/videos/clip");
  video.currentTime = 2.5; fireEvent.timeUpdate(video); expect(onTime).toHaveBeenCalledWith(2.5);
  expect(vi.mocked(fetch).mock.calls.every(call => call[1]?.method !== "POST")).toBe(true);
});
