import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import FootprintInspector from "./footprint-inspector";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";

it("authors a recess without changing the source, then binds openings to stable walls", () => {
  const object = newComponent("building", 10, 10), before = structuredClone(object), change = vi.fn(), error = vi.fn();
  render(<FootprintInspector object={object} definition={{ ...emptyPlaceScene(), objects: [object] }} onChange={change} onError={error}/>);
  fireEvent.click(screen.getByText("Edit outline")); fireEvent.click(screen.getByLabelText("Add footprint recess"));
  expect(screen.getByLabelText("Footprint corner 8 x")).toBeTruthy();
  expect(change).not.toHaveBeenCalled(); expect(object).toEqual(before);
  fireEvent.click(screen.getByText("Apply outline"));
  const next = change.mock.calls[0]![0].structure;
  expect(next.footprint).toHaveLength(8); expect(next.footprint.some((p: {id: string}) => p.id === next.door.wall_id)).toBe(true);
  expect(next.door.id).toBe(object.structure!.door.id); expect(error).not.toHaveBeenCalled();
});
it("retains invalid intermediate corners in the draft until repaired or cancelled", () => {
  const object = newComponent("building", 10, 10), change = vi.fn(), error = vi.fn();
  render(<FootprintInspector object={object} definition={{ ...emptyPlaceScene(), objects: [object] }} onChange={change} onError={error}/>);
  fireEvent.click(screen.getByText("Edit outline"));
  fireEvent.change(screen.getByLabelText("Footprint corner 1 x"), { target: { value: "-3" } });
  fireEvent.click(screen.getByText("Apply outline"));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("right angles")); expect(change).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Footprint corner 1 x") as HTMLInputElement).value).toBe("-3");
  fireEvent.click(screen.getByText("Cancel outline")); expect(change).not.toHaveBeenCalled();
});
it("rejects recesses beyond an edge and retains existing wall identities during editing", () => {
  const object = newComponent("building", 10, 10), change = vi.fn(), error = vi.fn();
  const definition = { ...emptyPlaceScene(), objects: [object] };
  const view = render(<FootprintInspector object={object} definition={definition} onChange={change} onError={error}/>);
  fireEvent.click(screen.getByText("Edit outline"));
  fireEvent.change(screen.getByLabelText("Recess width"), { target: { value: "50" } });
  fireEvent.click(screen.getByLabelText("Add footprint recess")); expect(error).toHaveBeenCalled();
  fireEvent.click(screen.getByText("Apply outline"));
  const structure = change.mock.calls[0]![0].structure;
  view.rerender(<FootprintInspector object={{ ...object, structure }} definition={definition} onChange={change} onError={error}/>);
  fireEvent.click(screen.getByText("Edit outline")); fireEvent.click(screen.getByText("Apply outline"));
  expect(change.mock.calls[1]![0].structure).toEqual(structure);
});
it("trims a corner into an L-shaped building through ordinary controls", () => {
  const object = newComponent("building", 10, 10), change = vi.fn(), error = vi.fn();
  render(<FootprintInspector object={object} definition={{ ...emptyPlaceScene(), objects: [object] }} onChange={change} onError={error}/>);
  fireEvent.click(screen.getByText("Edit outline")); fireEvent.click(screen.getByText("Trim corner"));
  fireEvent.click(screen.getByText("Apply outline"));
  expect(change.mock.calls[0]![0].structure.footprint).toHaveLength(6); expect(error).not.toHaveBeenCalled();
});
it("does not discard a footprint draft that would cut away existing furniture", () => {
  const object = newComponent("building", 10, 10), change = vi.fn(), error = vi.fn();
  const prop = { ...newComponent("barrels", 3, 0), width: 0.5, depth: 0.5, placement: { building_id: object.id, floor_id: object.structure!.floors[0]!.id } };
  render(<FootprintInspector object={object} definition={{ ...emptyPlaceScene(), objects: [object, prop] }} onChange={change} onError={error}/>);
  fireEvent.click(screen.getByText("Edit outline")); fireEvent.click(screen.getByLabelText("Add footprint recess"));
  fireEvent.click(screen.getByText("Apply outline"));
  expect(change).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith(expect.stringContaining("compound floor"));
  expect(screen.getByLabelText("Footprint corner 8 x")).toBeTruthy();
});
