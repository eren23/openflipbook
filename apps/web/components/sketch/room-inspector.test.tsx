import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import RoomInspector from "./room-inspector";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
import type { PlaceSceneObject } from "@openflipbook/config";

function building() {
  const object = newComponent("building", 12, 10); object.height = 7.8;
  object.structure!.floors.push({ id: "upper", label: "Upper" });
  return object;
}

// Holds the object like the editor does, so each accepted change re-renders.
function Harness({ onError, onFloorSelect }: { onError: (m: string) => void; onFloorSelect: (id: string) => void }) {
  const [object, setObject] = useState<PlaceSceneObject>(building);
  const [floor, setFloor] = useState<string | undefined>(undefined);
  return <>
    <output data-testid="layout">{JSON.stringify(object.structure!.floors.map(f => f.layout ?? null))}</output>
    <RoomInspector object={object} definition={{ ...emptyPlaceScene(), objects: [object] }} activeFloorId={floor}
      onChange={patch => setObject(o => ({ ...o, ...patch }))} onError={onError}
      onFloorSelect={id => { setFloor(id); onFloorSelect(id); }}/>
  </>;
}
const layouts = () => JSON.parse(screen.getByTestId("layout").textContent!) as ({ type: string; label?: string } | null)[];

it("creates, names, splits, edits and merges the rooms of one floor", () => {
  const error = vi.fn(), floorSelect = vi.fn();
  render(<Harness onError={error} onFloorSelect={floorSelect}/>);
  fireEvent.click(screen.getByRole("button", { name: "Create room layout" }));
  expect(layouts()[0]).toMatchObject({ type: "room", label: "Main room" });
  expect(floorSelect).toHaveBeenLastCalledWith(expect.any(String));

  fireEvent.change(screen.getByLabelText("Room name"), { target: { value: "Taproom" } });
  expect(layouts()[0]).toMatchObject({ type: "room", label: "Taproom" });

  fireEvent.change(screen.getByLabelText("Room split direction"), { target: { value: "z" } });
  fireEvent.click(screen.getByRole("button", { name: "Split room" }));
  expect(error).not.toHaveBeenCalled();
  expect(layouts()[0]).toMatchObject({ type: "split", axis: "z" });
  expect(screen.getByLabelText("Selected room")).toHaveProperty("value", expect.any(String));

  const position = Number((screen.getByLabelText("Partition position") as HTMLInputElement).value);
  fireEvent.change(screen.getByLabelText("Partition position"), { target: { value: String(position + 0.5) } });
  expect(layouts()[0]).toMatchObject({ position: position + 0.5 });
  fireEvent.change(screen.getByLabelText("Interior door width"), { target: { value: "1" } });
  expect(layouts()[0]).toMatchObject({ door: { width: 1 } });
  fireEvent.change(screen.getByLabelText("Selected partition"), { target: { value: (screen.getByLabelText("Selected partition") as HTMLSelectElement).value } });

  fireEvent.click(screen.getByRole("button", { name: "Merge rooms" }));
  expect(layouts()[0]).toMatchObject({ type: "room", label: "Taproom" });
  expect(error).not.toHaveBeenCalled();
});

it("switches floors and reports a change the scene rejects instead of applying it", () => {
  const error = vi.fn(), floorSelect = vi.fn();
  render(<Harness onError={error} onFloorSelect={floorSelect}/>);
  fireEvent.change(screen.getByLabelText("Room layout floor"), { target: { value: "upper" } });
  expect(floorSelect).toHaveBeenLastCalledWith("upper");
  fireEvent.click(screen.getByRole("button", { name: "Create room layout" }));
  expect(layouts()[1]).toMatchObject({ type: "room" });
  fireEvent.click(screen.getByRole("button", { name: "Split room" }));
  const before = JSON.stringify(layouts());
  // A partition far outside the footprint cannot be valid.
  fireEvent.change(screen.getByLabelText("Partition position"), { target: { value: "500" } });
  expect(error).toHaveBeenCalled();
  expect(JSON.stringify(layouts())).toBe(before);
});
