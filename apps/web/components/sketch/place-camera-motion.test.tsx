import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SavedPlaceView } from "@/lib/place-view";
import type { MotionReferenceCapture } from "./camera-motion-capture";
import PlaceCameraMotion from "./place-camera-motion";
import { motionComparisonPlan } from "@/lib/motion-comparison";
import { motionStudyFixture } from "@/tests/fixtures/motion-study";
vi.mock("./motion-study-library", () => ({ default: () => null }));
const view = { id: "view", width: 64, height: 32, historical: false, sources: [], assets: [],
  path: { duration: 6, time: 0, target_id: "inn", keyframes: [] } } as unknown as SavedPlaceView;
const result = { version: 1, preparation_sha256: "a", preflight: { status: "clear" }, comparison: motionComparisonPlan(motionStudyFixture()), frames: [0, 6].map(seconds => ({
  seconds, time: seconds / 6, capture: { passes: { render: "data:image/png;base64,aA==" } },
  measurements: { landmarks: [{ object_id: "inn", pixels: 40, touches_frame: false }] },
})) } as MotionReferenceCapture;
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => Response.json({ preparation_sha256: "a" }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("prepares on explicit intent, rechecks dependencies, and scrubs locally without generation", async () => {
  const capture = vi.fn(async () => result);
  render(<PlaceCameraMotion sessionId="world" view={view} disabled={false} captureMotion={capture}/>);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Prepare motion references" }));
  await screen.findByRole("slider", { name: "Motion reference time" });
  expect(capture).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").textContent).toContain("H3 uncalibrated");
  expect(screen.getByLabelText("Local comparison readiness").textContent).toContain("Local comparison reference / ready");
  fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } });
  expect(screen.getByAltText("Motion geometry reference at 6.00 seconds")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(fetch).mock.calls) expect(call[1]?.method).toBeUndefined();
});
it("shows incomplete comparison anchors before uploading any reference", async () => {
  const incomplete = structuredClone(result);
  incomplete.comparison.issues = ["Two measurable neighboring landmarks are required throughout the path"];
  render(<PlaceCameraMotion sessionId="world" view={view} disabled={false} captureMotion={async () => incomplete}/>);
  fireEvent.click(screen.getByRole("button", { name: "Prepare motion references" }));
  const readiness = await screen.findByLabelText("Local comparison readiness");
  expect(readiness.textContent).toContain("Local comparison reference / incomplete");
  expect(readiness.textContent).toContain("Two measurable neighboring landmarks");
  for (const call of vi.mocked(fetch).mock.calls) expect(call[1]?.method).toBeUndefined();
});
it("discards results if the accepted image or scene changed during capture", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ preparation_sha256: "a" })).mockResolvedValueOnce(Response.json({ preparation_sha256: "b" }));
  render(<PlaceCameraMotion sessionId="world" view={view} disabled={false} captureMotion={async () => result}/>);
  fireEvent.click(screen.getByRole("button", { name: "Prepare motion references" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Motion source changed");
  expect(screen.queryByRole("slider")).toBeNull();
});
it("aborts pending captures on edits and ignores late results", async () => {
  let complete!: (value: MotionReferenceCapture) => void;
  const capture = vi.fn((_view, _preparation, _signal: AbortSignal) => new Promise<MotionReferenceCapture>(resolve => { complete = resolve; }));
  const app = render(<PlaceCameraMotion sessionId="world" view={view} disabled={false} captureMotion={capture}/>);
  fireEvent.click(screen.getByRole("button", { name: "Prepare motion references" }));
  await waitFor(() => expect(capture).toHaveBeenCalledOnce());
  const signal = capture.mock.calls[0]![2];
  app.rerender(<PlaceCameraMotion sessionId="world" view={view} disabled={true} captureMotion={capture}/>);
  expect(signal.aborted).toBe(true); complete(result);
  await waitFor(() => expect((screen.getByRole("button", { name: "Prepare motion references" }) as HTMLButtonElement).disabled).toBe(true));
  expect(screen.queryByRole("slider")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("reports preparation errors without starting local capture", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Capture the path at its start" }, { status: 409 }));
  const capture = vi.fn(async () => result);
  render(<PlaceCameraMotion sessionId="world" view={view} disabled={false} captureMotion={capture}/>);
  fireEvent.click(screen.getByRole("button", { name: "Prepare motion references" }));
  expect((await screen.findByRole("alert")).textContent).toContain("at its start"); expect(capture).not.toHaveBeenCalled();
});
