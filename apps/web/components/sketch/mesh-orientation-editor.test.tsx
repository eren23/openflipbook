import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MeshOrientationEditor from "./mesh-orientation-editor";

it("keeps legacy orientation unchanged until explicit input and preserves other axes", () => {
  const onChange = vi.fn(); const view = render(<MeshOrientationEditor disabled={false} onChange={onChange}/>);
  expect(onChange).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Reset mesh source orientation" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Source pitch") as HTMLSelectElement).value).toBe("0");
  fireEvent.change(screen.getByLabelText("Source pitch"), { target: { value: "1" } });
  expect(onChange).toHaveBeenLastCalledWith({ x: 1, y: 0, z: 0 });
  view.rerender(<MeshOrientationEditor value={{ x: 1, y: 2, z: 0 }} disabled={false} onChange={onChange}/>);
  fireEvent.change(screen.getByLabelText("Source roll"), { target: { value: "3" } });
  expect(onChange).toHaveBeenLastCalledWith({ x: 1, y: 2, z: 3 });
  fireEvent.click(screen.getByRole("button", { name: "Reset mesh source orientation" }));
  expect(onChange).toHaveBeenLastCalledWith({ x: 0, y: 0, z: 0 });
});
it("disables orientation controls while another scene operation is in flight", () => {
  render(<MeshOrientationEditor value={{ x: 1, y: 0, z: 0 }} disabled onChange={vi.fn()}/>);
  for (const control of screen.getAllByRole("combobox")) expect((control as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Reset mesh source orientation" }) as HTMLButtonElement).disabled).toBe(true);
});
