import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MapCrop, ObserverPose, WorldEntityGeo } from "@openflipbook/config";

import ObserverGazeEditor from "./ObserverGazeEditor";

function geo(id: string, x: number, y: number): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label: id,
    pos: { x, y },
    height: 5,
    footprint: { w: 6, d: 6 },
    visual: "",
    state: {},
    confidence: 1,
    source: "user",
    updated_at: "t",
  };
}

const CROP: MapCrop = { x: 0, y: 0, w: 100, h: 100 };
// Camera at the south edge looking north (-y) → sees entities at smaller y.
const OBS: ObserverPose = {
  pos: { x: 50, y: 90 },
  eye_height: 1.7,
  gaze: -Math.PI / 2,
  fov: Math.PI / 2,
};

describe("ObserverGazeEditor", () => {
  it("lists the in-frame entities (live projection) + renders both handles", () => {
    render(
      <ObserverGazeEditor
        entities={[geo("tower", 50, 30), geo("behind", 50, 99)]}
        crop={CROP}
        observer={OBS}
      />,
    );
    const list = screen.getByTestId("in-frame");
    expect(list.textContent).toContain("tower");
    expect(list.textContent).not.toContain("behind"); // behind the camera → culled
    // presence asserted by getByTestId throwing if absent
    screen.getByTestId("observer-handle");
    screen.getByTestId("gaze-handle");
  });

  it("shows the empty state when nothing is in frame", () => {
    render(<ObserverGazeEditor entities={[geo("behind", 50, 99)]} crop={CROP} observer={OBS} />);
    expect(screen.getByTestId("in-frame").textContent).toMatch(/nothing in frame/i);
  });

  it("dragging the camera handle emits a moved observer", () => {
    const onChange = vi.fn();
    render(
      <ObserverGazeEditor
        entities={[geo("tower", 50, 30)]}
        crop={CROP}
        observer={OBS}
        size={200}
        onChange={onChange}
      />,
    );
    fireEvent.pointerDown(screen.getByTestId("observer-handle"));
    fireEvent.pointerMove(screen.getByRole("img"), { clientX: 24, clientY: 24 });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0]![0].pos).not.toEqual(OBS.pos);
  });
});
