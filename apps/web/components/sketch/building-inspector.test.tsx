import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import BuildingInspector from "./building-inspector";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
import type { PlaceSceneObject } from "@openflipbook/config";

function fixture() {
  const object = newComponent("building", 10, 10); object.height = 7.8;
  object.structure!.floors.push({ id: "upper", label: "Upper" });
  return { object, definition: { ...emptyPlaceScene(), objects: [object] } };
}
it("authors a stable stair identity and keeps it when the climbing direction changes", () => {
  const { object, definition } = fixture(), change = vi.fn(), error = vi.fn();
  const props = { object, definition, onChange: change, onError: error, onFloorSelect: vi.fn() };
  const view = render(<BuildingInspector {...props}/>);
  fireEvent.change(screen.getByLabelText("Stair centre x"), { target: { value: "0" } });
  const first = change.mock.calls[0]![0] as Partial<PlaceSceneObject>;
  expect(first.structure!.stair).toMatchObject({ id: expect.any(String), x: 0, direction: "north" });
  view.rerender(<BuildingInspector {...props} object={{ ...object, ...first }}/>);
  fireEvent.change(screen.getByLabelText("Stair climbing direction"), { target: { value: "east" } });
  expect(change.mock.calls[1]![0].structure.stair).toEqual({ ...first.structure!.stair, direction: "east" });
  expect(error).not.toHaveBeenCalled();
});
it("rejects an out-of-envelope stair before publishing a draft change", () => {
  const { object, definition } = fixture(), change = vi.fn(), error = vi.fn();
  render(<BuildingInspector object={object} definition={definition} onChange={change} onError={error} onFloorSelect={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText("Stair centre z"), { target: { value: "50" } });
  expect(change).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith(expect.stringContaining("landing clearance"));
});
it("removes the authored flight with its upper floor without changing the ground identity", () => {
  const { object, definition } = fixture(), change = vi.fn();
  object.structure!.stair = { id: "flight", x: 0, z: 0, direction: "east" };
  render(<BuildingInspector object={object} definition={definition} onChange={change} onError={vi.fn()} onFloorSelect={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText("Building floors"), { target: { value: "1" } });
  const result = change.mock.calls[0]![0];
  expect(result.structure).not.toHaveProperty("stair"); expect(result.structure.floors).toEqual([object.structure!.floors[0]]);
  expect(result.height).toBeCloseTo(4.6);
});
it("changes mesh-backed floor count without resizing the source asset envelope", () => {
  const { object, definition } = fixture(), change = vi.fn(); object.asset_id = "mesh"; object.mesh_scale = "uniform";
  render(<BuildingInspector object={object} definition={definition} onChange={change} onError={vi.fn()} onFloorSelect={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText("Building floors"), { target: { value: "1" } });
  const patch = change.mock.calls[0]![0]; expect(patch.height).toBe(object.height); expect(patch).not.toHaveProperty("width"); expect(patch).not.toHaveProperty("depth");
  expect(patch.structure.floors).toHaveLength(1); expect(patch.structure.roof_height).toBe(4);
});
it("edits walls, floor names, the doorway and windows as structure patches", () => {
  const { object, definition } = fixture(), change = vi.fn(), error = vi.fn();
  const props = { object, definition, onChange: change, onError: error, onFloorSelect: vi.fn() };
  const view = render(<BuildingInspector {...props}/>);
  const last = () => change.mock.calls.at(-1)![0].structure;
  fireEvent.change(screen.getByLabelText("Wall thickness"), { target: { value: "0.3" } });
  expect(last().wall_thickness).toBe(0.3);
  fireEvent.change(screen.getByLabelText("Floor 2 name"), { target: { value: "Loft" } });
  expect(last().floors[1]).toMatchObject({ id: "upper", label: "Loft" });
  fireEvent.change(screen.getByLabelText("Doorway width"), { target: { value: "1.4" } });
  expect(last().door.width).toBe(1.4);
  fireEvent.change(screen.getByLabelText("Doorway wall"), { target: { value: "west" } });
  expect(last().door.side).toBe("west");

  fireEvent.click(screen.getByRole("button", { name: "Add window" }));
  const withWindow = last();
  expect(withWindow.windows).toHaveLength(object.structure!.windows.length + 1);
  view.rerender(<BuildingInspector {...props} object={{ ...object, structure: withWindow }}/>);
  const n = withWindow.windows.length;
  fireEvent.change(screen.getByLabelText(`Window ${n} floor`), { target: { value: "1" } });
  expect(last().windows[n - 1].floor).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: `Remove window ${n}` }));
  expect(last().windows).toHaveLength(n - 1);
  expect(error).not.toHaveBeenCalled();
});
