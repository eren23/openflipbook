import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MotionReview from "./motion-review";
import { motionStudyFixture } from "@/tests/fixtures/motion-study";
import { motionComparisonPlan } from "@/lib/motion-comparison";
const plan = motionComparisonPlan(motionStudyFixture());
const props = { sessionId: "world", studyId: "study", assetId: "clip", comparison: { sha256: "frozen", plan },
  media: { width: 640, height: 480, duration: 6 }, onClose: vi.fn(), onSave: vi.fn(async (_body: Record<string, unknown>) => true) };
beforeEach(() => {
  vi.clearAllMocks(); props.onSave.mockResolvedValue(true);
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function ready(container: HTMLElement) {
  const video = container.querySelector("video")!;
  Object.defineProperties(video, { duration: { configurable: true, value: 6 }, paused: { configurable: true, value: true }, seeking: { configurable: true, value: false }, readyState: { configurable: true, value: 2 } });
  fireEvent.loadedMetadata(video); fireEvent.loadedData(video); fireEvent.load(screen.getByAltText("Geometry sample 1"));
  await waitFor(() => expect((screen.getByLabelText("Observed landmark visibility") as HTMLSelectElement).disabled).toBe(false)); return video;
}
it("starts unmeasured and never copies the reference bounds into the video review", async () => {
  const ui = render(<MotionReview {...props}/>); await ready(ui.container);
  expect(screen.getByRole("status", { name: "Comparison verdict" }).textContent).toBe("Human comparison / incomplete");
  expect((screen.getByLabelText("Observed left percent") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Save comparison review" }));
  await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
  expect(props.onSave.mock.calls[0]![0]).toMatchObject({ comparison_sha256: "frozen", review: { observations: [], visual: { architecture: "unreviewed" } } });
});
it("supports keyboard bounds and binds them to the selected video timestamp", async () => {
  const ui = render(<MotionReview {...props}/>); await ready(ui.container);
  for (const [label, value] of [["left", "10"], ["top", "30"], ["right", "25"], ["bottom", "60"]]) fireEvent.change(screen.getByLabelText(`Observed ${label} percent`), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Apply bounds" }));
  fireEvent.click(screen.getByRole("button", { name: "Save comparison review" }));
  await waitFor(() => expect(props.onSave).toHaveBeenCalled());
  expect(props.onSave.mock.calls[0]![0]).toMatchObject({ review: { observations: [{ frame: 0, object_id: "target", observed_seconds: 0, bounds: [.1, .3, .25, .6] }] } });
});
it("retains absent-landmark failures and freezes the same review after a lost response", async () => {
  props.onSave.mockResolvedValueOnce(false);
  const ui = render(<MotionReview {...props}/>); await ready(ui.container);
  fireEvent.change(screen.getByLabelText("Observed landmark visibility"), { target: { value: "absent" } });
  expect(screen.getByRole("status", { name: "Comparison verdict" }).textContent).toBe("Human comparison / fail");
  fireEvent.click(screen.getByRole("button", { name: "Save comparison review" }));
  await screen.findByRole("button", { name: "Retry same review" });
  expect((screen.getByLabelText("Comparison landmark") as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry same review" }));
  await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(2));
  expect(props.onSave.mock.calls[0]![0]).toEqual(props.onSave.mock.calls[1]![0]);
});
it("rejects a seek event at the wrong timestamp and unlocks only the matching frame", async () => {
  const ui = render(<MotionReview {...props}/>); const video = await ready(ui.container);
  fireEvent.change(screen.getByLabelText("Comparison sample"), { target: { value: "4" } });
  video.currentTime = 0;
  fireEvent.seeked(video); fireEvent.load(screen.getByAltText("Geometry sample 5"));
  await waitFor(() => expect(screen.getByLabelText("Video sample time").textContent).toBe("0.00s / requested 6.00s"));
  expect((screen.getByLabelText("Observed landmark visibility") as HTMLSelectElement).disabled).toBe(true);
  video.currentTime = 5.96; fireEvent.seeked(video);
  await waitFor(() => expect((screen.getByLabelText("Observed landmark visibility") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Observed landmark visibility"), { target: { value: "absent" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comparison review" }));
  await waitFor(() => expect(props.onSave).toHaveBeenCalled());
  expect(props.onSave.mock.calls[0]![0]).toMatchObject({ review: { observations: [{ frame: 4, observed_seconds: 5.96, bounds: null }] } });
});
it("keeps measurement disabled during continuous playback", async () => {
  const ui = render(<MotionReview {...props}/>); const video = await ready(ui.container);
  const play = vi.spyOn(video, "play").mockImplementation(async () => {
    Object.defineProperty(video, "paused", { configurable: true, value: false }); fireEvent.play(video);
  });
  fireEvent.click(screen.getByRole("button", { name: "Play full clip" }));
  await waitFor(() => expect(play).toHaveBeenCalledOnce());
  fireEvent.seeked(video);
  expect((screen.getByLabelText("Observed landmark visibility") as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Pause clip" })).toBeDefined();
  Object.defineProperty(video, "paused", { configurable: true, value: true }); fireEvent.pause(video);
  expect((screen.getByLabelText("Observed landmark visibility") as HTMLSelectElement).disabled).toBe(false);
});
it("draws bounds with the pointer, walks samples and landmarks, and reports media errors", async () => {
  const ui = render(<MotionReview {...props}/>); const video = await ready(ui.container);
  const surface = screen.getByRole("img", { name: "Video landmark bounds" });
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  // A cancelled or lost gesture measures nothing.
  fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 10, clientY: 20 }); fireEvent.pointerCancel(surface, { pointerId: 1 });
  fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 10, clientY: 20 }); fireEvent.lostPointerCapture(surface, { pointerId: 2 });
  expect(screen.getByText(/^0 \/ \d+ measurements$/)).toBeTruthy();
  fireEvent.pointerDown(surface, { button: 0, pointerId: 3, clientX: 10, clientY: 20 });
  fireEvent.pointerMove(surface, { pointerId: 3, clientX: 40, clientY: 60 });
  fireEvent.pointerUp(surface, { pointerId: 3, clientX: 40, clientY: 60 });
  await waitFor(() => expect((screen.getByLabelText("Observed right percent") as HTMLInputElement).value).toBe("40"));
  fireEvent.click(screen.getByRole("button", { name: "Clear landmark measurement" }));
  expect((screen.getByLabelText("Observed right percent") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Observed landmark visibility"), { target: { value: "absent" } });
  fireEvent.change(screen.getByLabelText("Observed landmark visibility"), { target: { value: "unreviewed" } });
  expect(screen.getByText(/^0 \/ \d+ measurements$/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Architecture and landmark identity"), { target: { value: "pass" } });
  fireEvent.change(screen.getByLabelText("Motion review notes"), { target: { value: "Steady dolly" } });
  fireEvent.change(screen.getByLabelText("Comparison landmark"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Next sample" }));
  expect((screen.getByLabelText("Comparison sample") as HTMLSelectElement).value).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Previous sample" }));
  expect((screen.getByLabelText("Comparison sample") as HTMLSelectElement).value).toBe("0");
  fireEvent.click(screen.getByRole("button", { name: "Return to sample" }));
  video.currentTime = 1.5; fireEvent.timeUpdate(video); fireEvent.seeking(video);
  expect(screen.getByLabelText("Video sample time").textContent).toContain("1.50s");

  fireEvent.error(screen.getByAltText("Geometry sample 1"));
  expect((await screen.findByRole("alert")).textContent).toBe("Reference image unavailable");
  fireEvent.error(video);
  expect(screen.getByRole("alert").textContent).toBe("Video unavailable");

  fireEvent.click(screen.getByRole("button", { name: "Save comparison review" }));
  await waitFor(() => expect(props.onSave).toHaveBeenCalled());
  expect(props.onSave.mock.calls[0]![0]).toMatchObject({ review: { notes: "Steady dolly", visual: { architecture: "pass" } } });
});
it("closes from the button and from Escape when no save is running", () => {
  render(<MotionReview {...props}/>);
  fireEvent.click(screen.getByRole("button", { name: "Close camera comparison" }));
  fireEvent(screen.getByRole("dialog", { hidden: true }), new Event("cancel", { cancelable: true }));
  expect(props.onClose).toHaveBeenCalledTimes(2);
});
