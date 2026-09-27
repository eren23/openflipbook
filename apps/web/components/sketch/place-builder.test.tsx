import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import PlaceBuilder from "./place-builder";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
import type { PlaceBuildJob } from "@/lib/place-build";
import type { PlaceSceneSnapshot } from "@openflipbook/config";

const fetcher = vi.fn(), scene: PlaceSceneSnapshot = { id: "scene", session_id: "world", place_id: "place", revision: 1, source_node_id: null, source_image_key: null, updated_at: "now", definition: emptyPlaceScene() };
const config = { enabled: true, model: "fixture", reservation: 0.2, floor_target_version: 1 };
let jobs: PlaceBuildJob[];
const job = (id: string): PlaceBuildJob => ({ id, prompt: "Two workshops", model: "fixture", reservation: 0.2, base_revision: 1, status: "queued", created_at: "now" });
beforeEach(() => {
  jobs = []; fetcher.mockReset(); vi.stubGlobal("fetch", fetcher);
  fetcher.mockImplementation(async (_url, options) => {
    if (!options?.body) return Response.json({ jobs, capabilities: config });
    const body = JSON.parse(options.body);
    return Response.json({ job: job(body.id) });
  });
});
const draw = () => render(<PlaceBuilder scene={scene} disabled={false} onPreview={vi.fn()} onBusy={vi.fn()} />);
const consent = async () => { await screen.findByText("fixture / architecture layout"); fireEvent.change(screen.getByLabelText("Place description"), { target: { value: "Two workshops" } }); fireEvent.click(screen.getByRole("checkbox")); };
const writes = () => fetcher.mock.calls.filter(([, opts]) => opts?.body).map(([, opts]) => JSON.parse(opts.body));
it("revalidates a rejected saved result explicitly without generation consent or a new job", async () => {
  jobs = [{ ...job("rejected"), status: "invalid", error: "Previous validation failed" }];
  fetcher.mockImplementation(async (_url, options) => options?.body
    ? Response.json({ job: { ...jobs[0], status: "validating" } })
    : Response.json({ jobs, capabilities: { enabled: false } }));
  draw(); await screen.findByRole("button", { name: "Revalidate saved response" }); expect(writes()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Revalidate saved response" }));
  await screen.findByText("validating"); expect(writes()).toEqual([{ action: "revalidate", id: "rejected" }]);
});
it("freezes the explicit floor across a lost response and later editor selection", async () => {
  const building = newComponent("building", 20, 15), target = { building_id: building.id, floor_id: building.structure!.floors[0]!.id };
  const scoped = { ...scene, definition: { ...scene.definition, objects: [building] } };
  let first = true;
  fetcher.mockImplementation(async (_url, options) => {
    if (!options?.body) return Response.json({ jobs, capabilities: config });
    if (first) { first = false; throw new Error("Lost response"); }
    const body = JSON.parse(options.body); return Response.json({ job: { ...job(body.id), target_floor: target, status: "submission_unknown" } });
  });
  const props = { scene: scoped, disabled: false, onPreview: vi.fn(), onBusy: vi.fn(), onTargetFloorChange: vi.fn() };
  const view = render(<PlaceBuilder {...props} targetFloor={target}/>);
  await consent(); fireEvent.click(screen.getByRole("button", { name: "Generate layout" })); await screen.findByText("Lost response");
  expect(writes()[0].target_floor).toEqual(target);
  view.rerender(<PlaceBuilder {...props}/>);
  expect((screen.getByLabelText("Generation scope") as HTMLSelectElement).value).toBe(target.floor_id);
  expect((screen.getByLabelText("Generation scope") as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved request" }));
  await waitFor(() => expect(writes()).toHaveLength(3)); expect(writes()[0]).toEqual(writes()[1]);
});
it("requires fresh consent after changing floor scope and hides unsupported generation behind capability checks", async () => {
  const building = newComponent("building", 20, 15), target = { building_id: building.id, floor_id: building.structure!.floors[0]!.id };
  const props = { scene: { ...scene, definition: { ...scene.definition, objects: [building] } }, disabled: false, onPreview: vi.fn(), onBusy: vi.fn() };
  const view = render(<PlaceBuilder {...props}/>); await consent();
  view.rerender(<PlaceBuilder {...props} targetFloor={target}/>);
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  fetcher.mockResolvedValue(Response.json({ jobs, capabilities: { ...config, floor_target_version: 0 } }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh layout jobs" }));
  await screen.findByText("Floor generation requires updated backend and layout workers.");
  fireEvent.click(screen.getByRole("checkbox"));
  expect((screen.getByRole("button", { name: "Generate layout" }) as HTMLButtonElement).disabled).toBe(true); expect(writes()).toEqual([]);
});
it("never starts a saved queued job during mount or refresh", async () => {
  jobs = [job("saved")]; draw(); await screen.findByRole("button", { name: "Start reserved layout job" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh layout jobs" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); expect(writes()).toEqual([]);
});
it("shows changed connections and disables stale starts and previews without submitting", async () => {
  jobs = [{ ...job("queued"), stale_connections: true }, { ...job("ready"), status: "ready", stale_connections: true }];
  draw(); await screen.findAllByText("Saved connections changed; a new layout request is required.");
  expect((screen.getByRole("button", { name: "Start reserved layout job" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Preview generated layout" }) as HTMLButtonElement).disabled).toBe(true); expect(writes()).toEqual([]);
});
it("requires explicit consent and shows scheduling before acknowledgement returns", async () => {
  let finish!: (value: Response) => void;
  fetcher.mockImplementation(async (_url, options) => {
    if (!options?.body) return Response.json({ jobs, capabilities: config });
    const body = JSON.parse(options.body);
    if (body.action === "run") return new Promise<Response>(resolve => { finish = resolve; });
    return Response.json({ job: job(body.id) });
  });
  draw(); await screen.findByText("fixture / architecture layout");
  expect((screen.getByRole("button", { name: "Generate layout" }) as HTMLButtonElement).disabled).toBe(true); await consent();
  fireEvent.click(screen.getByRole("button", { name: "Generate layout" }));
  await screen.findByText("scheduled", { exact: true }); expect(writes().map(w => w.action)).toEqual(["queue", "run"]);
  await act(async () => finish(Response.json({ job: { ...job(writes()[0].id), status: "ready", object_count: 2 } })));
  await screen.findByRole("button", { name: "Preview generated layout" });
});
it("retries a lost queue response with the identical request, not a new billable job", async () => {
  let first = true;
  fetcher.mockImplementation(async (_url, options) => {
    if (!options?.body) return Response.json({ jobs, capabilities: config });
    if (first) { first = false; throw new Error("Lost response"); }
    const body = JSON.parse(options.body); return Response.json({ job: { ...job(body.id), status: "submission_unknown" } });
  });
  draw(); await consent(); fireEvent.click(screen.getByRole("button", { name: "Generate layout" }));
  await screen.findByText("Lost response"); expect((screen.getByLabelText("Place description") as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved request" }));
  await waitFor(() => expect(writes()).toHaveLength(3)); expect(writes()[0]).toEqual(writes()[1]);
});
it("unlocks rejected input after a definitive configuration or budget rejection", async () => {
  fetcher.mockImplementation(async (_url, options) => options?.body ? Response.json({ error: "Reservation changed" }, { status: 409 }) : Response.json({ jobs, capabilities: config }));
  draw(); await consent(); fireEvent.click(screen.getByRole("button", { name: "Generate layout" }));
  await screen.findByText("Reservation changed"); expect((screen.getByLabelText("Place description") as HTMLTextAreaElement).disabled).toBe(false);
});
it("allows material consent for the exact layout under review, but not unrelated dirty edits", async () => {
  jobs = [{ ...job("saved"), status: "ready", material_plan: [{ id: "wall", prompt: "Limestone walls", targets: [{ object_id: "building1", surface: "wall", tile_metres: 2, rotation: 0, roughness: 0.8 }] }] }];
  fetcher.mockImplementation(async () => Response.json({ jobs, capabilities: config, material_capabilities: { enabled: true, model: "tiles", reservation: 0.1, parameters: {} } }));
  const props = { scene, disabled: true, onPreview: vi.fn(), onBusy: vi.fn() };
  const view = render(<PlaceBuilder {...props} reviewingBuildId="saved"/>);
  const checkbox = await screen.findByRole("checkbox", { name: "Reserve $0.10 for 1 material" });
  expect((checkbox as HTMLInputElement).disabled).toBe(false);
  view.rerender(<PlaceBuilder {...props}/>);
  expect((checkbox as HTMLInputElement).disabled).toBe(true); expect(writes()).toEqual([]);
});
