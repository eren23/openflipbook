import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ControlledStudy from "@/app/dev/spatial-transitions/controlled/study";
import { CONTROLLED_IDS } from "@/lib/controlled-study";

const report = {
  version: 1, cap_usd: "3.00", reserved_usd: "1.90", complete: true,
  fixture: { signature: { crop: [0, .029, .528], landmark: [.082, .074, .127, .438], size: [1280, 704], frames: 121, fps: 24 }, content_rect: [9, 0, 1261, 704], fast_content_rect: [0, 4, 1920, 1072] },
  results: CONTROLLED_IDS.map(id => ({ id, label: id, state: "complete", visual_verdict: "unreviewed", reported_cost_usd: null, metadata: { width: id === "fast-101" ? 1920 : 1280, height: id === "fast-101" ? 1080 : 704, frame_count: id === "fast-101" ? 144 : 121, duration_seconds: id === "fast-101" ? 6 : 121 / 24, fps: "24/1" } })),
};
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(report))));
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("loads without submitting generation, scrubs and resets", async () => {
  render(<ControlledStudy />);
  await screen.findByText("Reserved: $1.90 / $3.00");
  expect(screen.getByText("unreviewed")).toBeTruthy();
  const videos = document.querySelectorAll("video");
  for (const video of videos) Object.defineProperty(video, "duration", { value: 121 / 24, configurable: true });
  fireEvent.change(screen.getByLabelText("Normalized progress"), { target: { value: "1" } });
  expect(videos[0]!.currentTime).toBeCloseTo(5);
  expect(videos[1]!.currentTime).toBeCloseTo(5);
  expect(screen.getByTestId("overlay-reference").style.height).toBeTruthy();
  fireEvent.seeking(videos[0]!);
  expect(screen.queryByTestId("overlay-reference")).toBeNull();
  fireEvent.seeked(videos[0]!);
  expect(screen.getByTestId("overlay-reference")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Reset"));
  expect(videos[0]!.currentTime).toBe(0);
  await act(async () => { fireEvent.click(screen.getByLabelText("Play")); });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByLabelText("Pause"));
  expect(vi.mocked(fetch).mock.calls.every(([url, options]) => String(url).endsWith("summary.json") && !options?.method)).toBe(true);
});

it("keeps native playback overlays on their own timelines", async () => {
  render(<ControlledStudy />);
  await screen.findByText("Reserved: $1.90 / $3.00");
  fireEvent.change(screen.getByLabelText("Configuration"), { target: { value: "fast-101" } });
  const video = document.querySelectorAll("video")[1]!;
  Object.defineProperty(video, "duration", { value: 6, configurable: true });
  video.currentTime = 3;
  fireEvent.timeUpdate(video);
  expect(screen.getByTestId("overlay-fast-101").style.height).not.toBe(screen.getByTestId("overlay-reference").style.height);
  fireEvent.click(screen.getByLabelText("Expected landmark"));
  expect(screen.queryByTestId("overlay-fast-101")).toBeNull();
});

it("displays stopped and missing outputs without generating replacements", async () => {
  const data = structuredClone(report);
  data.results[0]!.state = "stopped";
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(data)));
  render(<ControlledStudy />);
  await screen.findByText("Generation stopped");
  fireEvent.change(screen.getByLabelText("Configuration"), { target: { value: "fast-101" } });
  fireEvent.error(document.querySelectorAll("video")[1]!);
  expect(screen.getByText("Clip unavailable")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("handles absent reports and refreshes without a paid call", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));
  render(<ControlledStudy />);
  await screen.findByText("No pilot results yet.");
  expect(screen.getByLabelText("Play").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByLabelText("Refresh results"));
  await screen.findByText("Reserved: $1.90 / $3.00");
  await waitFor(() => expect(screen.queryByText("No pilot results yet.")).toBeNull());
});
