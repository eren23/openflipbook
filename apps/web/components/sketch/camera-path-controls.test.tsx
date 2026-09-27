import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import CameraPathControls from "./camera-path-controls";
import type { CameraRig, OrbitPose, CameraPathCheck } from "@/lib/camera-path";

let value: OrbitPose, listener: (event: "start" | "end" | "reset") => void, rig: CameraRig;
beforeEach(() => {
  value = { azimuth: 0, elevation: 30, distance: 20 };
  rig = { minElevation: 2, maxElevation: 89, minDistance: 2, maxDistance: 100,
    read: () => value, write: vi.fn(pose => { value = pose; }), targetSelection: vi.fn(() => "Workshop"), targetLabel: () => "Other target",
    check: vi.fn(async () => ({ status: "clear" as const, samples: 10, clearance: 0.2, visibility: "sampled" as const, issues: [] })),
    setActive: vi.fn(), subscribe: fn => { listener = fn; return vi.fn(); } };
});
function open() { render(<CameraPathControls rig={rig} selected="workshop"/>); fireEvent.click(screen.getByRole("button", { name: "Camera path" })); }
const numeric = (label: string) => screen.getByRole("spinbutton", { name: `${label} value` }) as HTMLInputElement;
it("does not move the camera before explicit opening, then edits the real rig", () => {
  render(<CameraPathControls rig={rig}/>); expect(rig.targetSelection).not.toHaveBeenCalled(); expect(rig.write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Camera path" }));
  expect(screen.getByText("Workshop")).toBeTruthy(); expect(rig.setActive).toHaveBeenLastCalledWith(true);
  fireEvent.change(numeric("Azimuth"), { target: { value: "90" } }); expect(value.azimuth).toBe(90);
  fireEvent.change(numeric("Distance"), { target: { value: "1000" } }); expect(value.distance).toBe(100);
  fireEvent.change(numeric("Elevation"), { target: { value: "-10" } }); expect(value.elevation).toBe(2);
});
it("scrubs, inserts and deletes interior keyframes without deleting endpoints", () => {
  open(); fireEvent.click(screen.getByRole("button", { name: "Camera keyframe 2" }));
  fireEvent.change(numeric("Azimuth"), { target: { value: "180" } });
  fireEvent.change(screen.getByRole("slider", { name: "Camera timeline" }), { target: { value: "0.5" } });
  expect(value.azimuth).toBe(90); expect(numeric("Azimuth").disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add camera keyframe" })); expect(numeric("Azimuth").disabled).toBe(false);
  expect(screen.getByRole("button", { name: "Camera keyframe 3" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete camera keyframe" })); expect(screen.queryByRole("button", { name: "Camera keyframe 3" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Rewind camera path" }));
  expect((screen.getByRole("button", { name: "Delete camera keyframe" }) as HTMLButtonElement).disabled).toBe(true);
});
it("reflects manual orbit gestures and resets the path when its pivot changes", () => {
  open(); value = { azimuth: -30, elevation: 40, distance: 15 };
  act(() => listener("end")); expect(numeric("Azimuth").value).toBe("-30");
  act(() => listener("reset")); expect(screen.getByText("Other target")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /Camera keyframe/ })).toHaveLength(2);
});
it("plays on explicit intent, stops on manual input and cancels its animation on unmount", async () => {
  let step!: FrameRequestCallback;
  const raf = vi.fn((fn: FrameRequestCallback) => { step = fn; return 42; }), cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", raf); vi.stubGlobal("cancelAnimationFrame", cancel);
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const ui = render(<CameraPathControls rig={rig}/>);
  fireEvent.click(screen.getByRole("button", { name: "Camera path" }));
  fireEvent.click(screen.getByRole("button", { name: "Camera keyframe 2" }));
  fireEvent.change(numeric("Azimuth"), { target: { value: "180" } });
  fireEvent.click(screen.getByRole("button", { name: "Play camera path" }));
  await screen.findByRole("button", { name: "Pause camera path" });
  // The frame loop starts in an effect after the Pause button renders.
  await waitFor(() => expect(raf).toHaveBeenCalled());
  act(() => step(3000)); expect(value.azimuth).toBe(90);
  act(() => listener("start")); expect(screen.getByRole("button", { name: "Play camera path" })).toBeTruthy(); expect(cancel).toHaveBeenCalledWith(42);
  fireEvent.click(screen.getByRole("button", { name: "Play camera path" }));
  await screen.findByRole("button", { name: "Pause camera path" });
  act(() => step(3000)); expect(value.azimuth).toBe(180); expect(screen.getByRole("button", { name: "Play camera path" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Play camera path" })); await screen.findByRole("button", { name: "Pause camera path" }); ui.unmount(); expect(cancel).toHaveBeenCalledWith(42); expect(rig.setActive).toHaveBeenLastCalledWith(false);
  now.mockRestore(); vi.unstubAllGlobals();
});
it("blocks playback on collisions and exposes a scrub target for each issue", async () => {
  rig.check = vi.fn(async (): Promise<CameraPathCheck> => ({ status: "blocked", samples: 20, clearance: 0.2, visibility: "sampled", issues: [{ kind: "collision", time: 0.5, end_time: 0.6 }] }));
  open(); fireEvent.click(screen.getByRole("button", { name: "Play camera path" }));
  await screen.findByText("Path blocked");
  expect((screen.getByRole("button", { name: "Play camera path" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Collision risk at 3.0s" }));
  expect((screen.getByRole("slider", { name: "Camera timeline" }) as HTMLInputElement).value).toBe("0.5");
  fireEvent.click(screen.getByRole("button", { name: "Rewind camera path" }));
  fireEvent.change(numeric("Distance"), { target: { value: "30" } });
  expect(screen.getByText("Path unchecked")).toBeTruthy();
});
it("discards an obsolete check after edits, scrubbing, and closing", async () => {
  let finish!: (report: Awaited<ReturnType<CameraRig["check"]>>) => void;
  rig.check = vi.fn(() => new Promise<CameraPathCheck>(resolve => { finish = resolve; }));
  const result = { status: "clear" as const, samples: 2, clearance: 0.2, visibility: "not_requested" as const, issues: [] };
  open();
  for (const action of [() => fireEvent.change(numeric("Distance"), { target: { value: "30" } }), () => fireEvent.click(screen.getByRole("button", { name: "Camera keyframe 2" })), () => fireEvent.click(screen.getByRole("button", { name: "Camera path" }))]) {
    fireEvent.click(screen.getByRole("button", { name: "Play camera path" }));
    await screen.findByText("Checking geometry..."); action();
    await act(async () => finish(result)); expect(screen.queryByRole("button", { name: "Pause camera path" })).toBeNull();
  }
});
it("shows checker failures without converting them into a pass", async () => {
  rig.check = vi.fn(async () => { throw new Error("Physics unavailable"); });
  open(); fireEvent.click(screen.getByRole("button", { name: "Check camera path" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Physics unavailable"));
  expect(screen.getByText("Path unchecked")).toBeTruthy(); expect(screen.queryByRole("button", { name: "Pause camera path" })).toBeNull();
});
it("loads saved keyframes and capture time without targeting again or starting playback", () => {
  rig.draft = vi.fn();
  const keyframes = [{ time: 0, azimuth: 0, elevation: 30, distance: 20 }, { time: 1, azimuth: 90, elevation: 40, distance: 30 }];
  const ui = render(<CameraPathControls rig={rig} initialPath={{ version: 1, duration: 6.5, time: 0.5, keyframes, pivot: [1, 2, 3], target_id: "target" }}/>);
  expect((screen.getByRole("slider", { name: "Camera timeline" }) as HTMLInputElement).value).toBe("0.5");
  expect((screen.getByRole("combobox", { name: "Camera path duration" }) as HTMLSelectElement).value).toBe("6.5");
  expect(numeric("Azimuth").value).toBe("45");
  expect(rig.targetSelection).not.toHaveBeenCalled(); expect(rig.check).not.toHaveBeenCalled(); expect(rig.write).not.toHaveBeenCalled();
  expect(rig.draft).toHaveBeenLastCalledWith({ duration: 6.5, time: 0.5, keyframes });
  ui.unmount(); expect(rig.draft).toHaveBeenLastCalledWith(null);
});
