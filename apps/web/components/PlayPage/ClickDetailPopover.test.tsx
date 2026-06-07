import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MapCrop, ObserverPose, WorldEntityGeo } from "@openflipbook/config";

import ClickDetailPopover from "./ClickDetailPopover";

const observer: ObserverPose = {
  pos: { x: 0, y: 10 },
  eye_height: 1.7,
  gaze: -Math.PI / 2,
  fov: Math.PI / 2,
  pitch: 0,
};
const crop: MapCrop = { x: -20, y: -20, w: 40, h: 40 };

function ent(id: string, x: number, y: number): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label: id,
    pos: { x, y },
    height: 4,
    footprint: { w: 4, d: 4 },
    visual: "",
    state: {},
    confidence: 1,
    source: "derived",
    updated_at: "t",
  };
}

function setup(initialOver: Partial<Parameters<typeof ClickDetailPopover>[0]["initial"]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ClickDetailPopover
      xPx={100}
      yPx={100}
      entities={[ent("a", 0, 0)]}
      crop={crop}
      initial={{
        observer,
        level: "building",
        focusLabel: "Tower of Art",
        canSubmap: true,
        mode: "scene",
        ...initialOver,
      }}
      aspect={16 / 9}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ClickDetailPopover", () => {
  it("seeds from the routed tap: focus label, active level, live preview", () => {
    setup();
    expect(screen.getByText("Tower of Art")).toBeTruthy();
    // the orphaned editor is mounted → its live in-frame preview is present
    expect(screen.getByTestId("in-frame")).toBeTruthy();
    expect(screen.getByTestId("observer-handle")).toBeTruthy();
    // the synthesized level is the active pill
    expect(screen.getByRole("button", { name: "building" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("'from below' tilts the camera up — the confirmed pose carries the change", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByTestId("chip-below"));
    fireEvent.click(screen.getByTestId("detail-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const result = onConfirm.mock.calls[0]![0];
    expect(result.observer.pitch).toBeGreaterThan(0); // looked up from below
  });

  it("the scene⇄submap toggle only appears when the tap is a cluster", () => {
    setup({ canSubmap: false });
    expect(screen.queryByTestId("mode-toggle")).toBeNull();
  });

  it("cancel dismisses without entering", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByTestId("detail-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a free-text detail flows into the confirmed result", () => {
    const { onConfirm } = setup();
    fireEvent.change(screen.getByTestId("detail-note"), {
      target: { value: "lit by torchlight" },
    });
    fireEvent.click(screen.getByTestId("detail-confirm"));
    expect(onConfirm.mock.calls[0]![0].note).toBe("lit by torchlight");
  });
});
