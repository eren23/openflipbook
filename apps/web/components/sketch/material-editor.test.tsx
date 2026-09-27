import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useState } from "react";
import type { SurfaceMaterial } from "@openflipbook/config";
import { newComponent } from "@/lib/place-scene";
import MaterialEditor, { GroundMaterialEditor } from "./material-editor";

vi.mock("./mesh-generator", () => ({ default: ({ onPlace }: { onPlace: (job: { asset_id: string }) => void }) => <button onClick={() => onPlace({ asset_id: "saved-material" })}>Use generated asset</button> }));

it("assigns, tunes and removes a ground material without an invented scene object", () => {
  const changed = vi.fn();
  function Editor() {
    const [binding, setBinding] = useState<SurfaceMaterial>();
    return <GroundMaterialEditor sessionId="world" binding={binding} onChange={value => { changed(value); setBinding(value); }}/>;
  }
  render(<Editor/>);
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Ground material" })).toBeTruthy();
  expect(screen.queryByLabelText("Material surface")).toBeNull();
  fireEvent.click(screen.getByText("Use generated asset"));
  expect(changed).toHaveBeenLastCalledWith({ asset_id: "saved-material", tile_metres: 2, rotation: 0, roughness: 0.85 });
  fireEvent.change(screen.getByLabelText("Material tile size"), { target: { value: "4" } });
  fireEvent.change(screen.getByLabelText("Material rotation"), { target: { value: "90" } });
  expect(changed).toHaveBeenLastCalledWith({ asset_id: "saved-material", tile_metres: 4, rotation: Math.PI / 2, roughness: 0.85 });
  fireEvent.click(screen.getByLabelText("Remove surface material"));
  expect(changed).toHaveBeenLastCalledWith(undefined);
});

it("never carries a building's selected wall surface onto a path", () => {
  const changed = vi.fn(), { rerender } = render(<MaterialEditor sessionId="world" object={newComponent("building", 10, 10)} onChange={changed}/>);
  fireEvent.change(screen.getByLabelText("Material surface"), { target: { value: "roof" } });
  rerender(<MaterialEditor sessionId="world" object={newComponent("path", 10, 10)} onChange={changed}/>);
  expect(screen.queryByLabelText("Material surface")).toBeNull();
  fireEvent.click(screen.getByText("Use generated asset"));
  expect(changed).toHaveBeenLastCalledWith({ materials: { floor: { asset_id: "saved-material", tile_metres: 2, rotation: 0, roughness: 0.85 } } });
});
