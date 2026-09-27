import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PlaceBuildJob } from "@/lib/place-build";
import BuildMaterials from "./build-assets";

const config = { enabled: true, model: "material-model", reservation: 0.1, parameters: { version: 1 } };
const job: PlaceBuildJob = { id: "layout1", prompt: "A workshop", model: "planner", reservation: 0.2, base_revision: 1, status: "ready", created_at: "now",
  material_plan: [{ id: "stone", prompt: "Grey limestone walls", targets: [{ object_id: "building1", surface: "wall", tile_metres: 2, rotation: 0, roughness: 0.8 }] }] };
function props() { return { job, config, disabled: false, stale: false, call: vi.fn().mockResolvedValue({}), refresh: vi.fn().mockResolvedValue(undefined), preview: vi.fn() }; }
it("does not schedule on mount; requires batch consent with pinned provider parameters", async () => {
  const p = props(); render(<BuildMaterials {...p}/>);
  expect(p.call).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Generate build materials" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Generate build materials" }));
  await waitFor(() => expect(p.refresh).toHaveBeenCalledTimes(1));
  expect(p.call.mock.calls[0]![0]).toMatchObject({ action: "materials", id: "layout1", confirmed: true, model: config.model, reservation: 0.1, parameters: config.parameters });
});
it("replays a lost batch acknowledgement identically even after provider configuration changes", async () => {
  const p = props(); p.call.mockRejectedValueOnce(new Error("Lost response"));
  const view = render(<BuildMaterials {...p}/>);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Generate build materials" }));
  await screen.findByText("Lost response");
  view.rerender(<BuildMaterials {...p} config={{ ...config, enabled: false, reservation: 0.3 }}/>);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved material request" }));
  await waitFor(() => expect(p.call).toHaveBeenCalledTimes(2));
  expect(p.call.mock.calls[1]![0]).toEqual(p.call.mock.calls[0]![0]);
});
it("requires renewed consent when the quoted price changes", () => {
  const p = props(), view = render(<BuildMaterials {...p}/>);
  fireEvent.click(screen.getByRole("checkbox"));
  view.rerender(<BuildMaterials {...p} config={{ ...config, reservation: 0.5 }}/>);
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: "Generate build materials" }) as HTMLButtonElement).disabled).toBe(true);
  expect(p.call).not.toHaveBeenCalled();
});
it("allows stale-stage cancellation but disables new paid work and previews", async () => {
  const p = props();
  const stage: PlaceBuildJob = { ...job, material_stage: { id: "stage1", status: "generating", reservation: 0.1,
    items: [{ plan_id: "stone", job: { id: "child1", prompt: "Stone", model: "material-model", reservation: 0.1, status: "running" } }] } };
  render(<BuildMaterials {...p} job={stage} stale/>);
  expect((screen.getByRole("button", { name: "Preview layout only" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel build materials" }));
  await waitFor(() => expect(p.call).toHaveBeenCalledWith({ action: "cancel-materials", id: "layout1" }));
});

const meshConfig = { enabled: true, model: "mesh-model", reservation: 2, parameters: { textured: true } };
const meshJob: PlaceBuildJob = { ...job, mesh_plan: [
  { id: "statue", prompt: "A weathered stone monument", role: "exterior", targets: [{ object_id: "volume1" }] },
  { id: "chair", prompt: "An oak chair", role: "prop", targets: [{ object_id: "volume2" }, { object_id: "volume3" }] },
] };
it("quotes mesh requests rather than placements and submits only the mesh stage", async () => {
  const p = props(); render(<BuildMaterials {...p} job={meshJob} kind="mesh" config={meshConfig}/>);
  expect(p.call).not.toHaveBeenCalled();
  expect(screen.getByText("1 placements / solid exterior, no interior")).toBeTruthy();
  expect(screen.getByText("2 placements / prop")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Generate build meshes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Reserve $4.00 for 2 meshes" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate build meshes" }));
  await waitFor(() => expect(p.refresh).toHaveBeenCalledTimes(1));
  expect(p.call.mock.calls[0]![0]).toMatchObject({ action: "meshes", id: job.id, confirmed: true, model: meshConfig.model, reservation: 2, parameters: meshConfig.parameters });
});
it("replays the exact mesh request after a lost response with changed configuration", async () => {
  const p = props(); p.call.mockRejectedValueOnce(new Error("Lost mesh response"));
  const view = render(<BuildMaterials {...p} job={meshJob} kind="mesh" config={meshConfig}/>);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Generate build meshes" }));
  await screen.findByText("Lost mesh response");
  view.rerender(<BuildMaterials {...p} job={meshJob} kind="mesh" config={{ ...meshConfig, enabled: false, reservation: 5 }}/>);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved mesh request" }));
  await waitFor(() => expect(p.call).toHaveBeenCalledTimes(2));
  expect(p.call.mock.calls[1]![0]).toEqual(p.call.mock.calls[0]![0]);
});
it("replaces only an explicitly approved failed mesh and leaves successful siblings alone", async () => {
  const p = props();
  const staged: PlaceBuildJob = { ...meshJob, mesh_stage: { id: "meshstage", status: "blocked", reservation: 4, items: [
    { plan_id: "statue", job: { id: "mesh1", prompt: "Monument", model: "mesh-model", reservation: 2, status: "ready" } },
    { plan_id: "chair", job: { id: "mesh2", prompt: "Chair", model: "mesh-model", reservation: 2, status: "failed" } },
  ] } };
  render(<BuildMaterials {...p} job={staged} kind="mesh" config={meshConfig}/>);
  expect(screen.getAllByRole("button", { name: "Replace failed mesh" })).toHaveLength(1);
  expect((screen.getByRole("button", { name: "Replace failed mesh" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Reserve $2.00 for replacement" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace failed mesh" }));
  await waitFor(() => expect(p.refresh).toHaveBeenCalledTimes(1));
  expect(p.call.mock.calls[0]![0]).toMatchObject({ action: "replace-mesh", plan_id: "chair", id: job.id, confirmed: true, reservation: 2 });
});
