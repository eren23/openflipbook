import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import MeshGenerator from "./mesh-generator";
import type { MeshJob } from "@/lib/mesh-asset";
import { MESH_IMAGE_MODEL } from "@/lib/mesh-asset";

const fetcher = vi.fn(), onPlace = vi.fn();
let jobs: MeshJob[], config: { enabled: boolean; model: string; reservation: number; parameters: { face_count: number } };
const job = (id = "fixture", status: MeshJob["status"] = "scheduled"): MeshJob => ({ id, prompt: "A stone fountain", model: "test", status, reservation: 2 });
beforeEach(() => {
  jobs = []; config = { enabled: true, model: "test", reservation: 2, parameters: { face_count: 40000 } }; fetcher.mockReset(); onPlace.mockReset(); vi.stubGlobal("fetch", fetcher);
  fetcher.mockImplementation(async (_url, opts) => {
    if (!opts?.body) return Response.json({ jobs, capabilities: config });
    const body = JSON.parse(opts.body); return Response.json({ job: job(body.id, body.action === "cancel" ? "cancelled" : "scheduled") });
  });
});
const draw = () => render(<MeshGenerator sessionId="world" onPlace={onPlace}/>);
const writes = () => fetcher.mock.calls.filter(([, opts]) => opts?.body).map(([, opts]) => JSON.parse(opts.body));
async function describe() { await screen.findByRole("checkbox"); fireEvent.change(screen.getByLabelText("3D object description"), { target: { value: "A stone fountain" } }); fireEvent.click(screen.getByRole("checkbox")); }
it("requires consent and schedules generation with the displayed configuration", async () => {
  draw(); await screen.findByRole("checkbox"); expect((screen.getByRole("button", { name: "Generate mesh" }) as HTMLButtonElement).disabled).toBe(true);
  await describe(); fireEvent.click(screen.getByRole("button", { name: "Generate mesh" })); await screen.findByText("scheduled", { exact: true });
  expect(writes()).toHaveLength(1); expect(writes()[0]).toMatchObject({ action: "generate", confirmed: true, reservation: 2, model: "test", parameters: { face_count: 40000 } });
});
it("does not retry failed storage during mount or status refresh", async () => {
  jobs = [job("saved", "storage_failed")]; draw(); await screen.findByRole("button", { name: "Retry mesh storage" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh mesh jobs" })); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); expect(writes()).toEqual([]);
});
it("requests storage retry without a new generation command", async () => {
  jobs = [job("saved", "storage_failed")]; draw(); fireEvent.click(await screen.findByRole("button", { name: "Retry mesh storage" }));
  await waitFor(() => expect(writes()).toEqual([{ action: "refresh", id: "saved" }]));
});
it("retains the full original request after a lost acknowledgement and config refresh", async () => {
  let first = true;
  fetcher.mockImplementation(async (_url, opts) => {
    if (!opts?.body) return Response.json({ jobs, capabilities: config });
    if (first) { first = false; throw new Error("Lost acknowledgement"); }
    const body = JSON.parse(opts.body); return Response.json({ job: job(body.id) });
  });
  draw(); await describe(); fireEvent.click(screen.getByRole("button", { name: "Generate mesh" })); await screen.findByText("Lost acknowledgement");
  config = { ...config, reservation: 3, parameters: { face_count: 80000 } };
  fireEvent.click(screen.getByRole("button", { name: "Refresh mesh jobs" })); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  await screen.findByText("Reserve $2.00 for this generation");
  expect((screen.getByLabelText("3D object description") as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved mesh request" })); await waitFor(() => expect(writes()).toHaveLength(2)); expect(writes()[1]).toEqual(writes()[0]);
});
it("unlocks the request after a definitive budget rejection", async () => {
  fetcher.mockImplementation(async (_url, opts) => opts?.body ? Response.json({ error: "Budget reached" }, { status: 429 }) : Response.json({ jobs, capabilities: config }));
  draw(); await describe(); fireEvent.click(screen.getByRole("button", { name: "Generate mesh" })); await screen.findByText("Budget reached");
  expect((screen.getByLabelText("3D object description") as HTMLTextAreaElement).disabled).toBe(false);
});
it("does not replay an uncertain request into a different world", async () => {
  fetcher.mockImplementation(async (_url, opts) => { if (opts?.body) throw new Error("Lost acknowledgement"); return Response.json({ jobs: [], capabilities: config }); });
  const view = draw(); await describe(); fireEvent.click(screen.getByRole("button", { name: "Generate mesh" })); await screen.findByText("Lost acknowledgement");
  view.rerender(<MeshGenerator sessionId="another-world" onPlace={onPlace}/>); await screen.findByRole("checkbox");
  expect(screen.queryByRole("button", { name: "Retry saved mesh request" })).toBeNull();
  expect((screen.getByLabelText("3D object description") as HTMLTextAreaElement).value).toBe("");
  expect((screen.getByRole("button", { name: "Generate mesh" }) as HTMLButtonElement).disabled).toBe(true); expect(writes()).toHaveLength(1);
});
it("exposes cancellation without claiming provider billing has stopped", async () => {
  jobs = [job("saved", "running")]; draw(); const cancel = await screen.findByRole("button", { name: "Cancel mesh job" }); expect(cancel.title).toContain("billable");
  fireEvent.click(cancel); await screen.findByText("cancelled", { exact: true }); expect(writes()).toEqual([{ action: "cancel", id: "saved" }]);
});
it("places only the selected saved asset without a generation call", async () => {
  jobs = [{ ...job("saved", "ready"), asset_id: "mesh_saved" }]; draw(); fireEvent.click(await screen.findByRole("button", { name: "Place in scene" }));
  expect(onPlace).toHaveBeenCalledWith(jobs[0]); expect(writes()).toEqual([]);
});
it("places immutable forked assets without requiring original jobs or an enabled model", async () => {
  fetcher.mockResolvedValue(Response.json({ jobs: [], capabilities: { enabled: false }, saved_meshes: [{ id: "mesh_forked", prompt: "Forked bakery", model: MESH_IMAGE_MODEL, sha256: "hash" }] }));
  draw(); fireEvent.click(await screen.findByRole("button", { name: "Place in scene" }));
  expect(onPlace).toHaveBeenCalledWith({ asset_id: "mesh_forked", prompt: "Forked bakery" }); expect(writes()).toEqual([]);
});
it("selects an image with separate consent, submits its identity and keeps the name out of image selection", async () => {
  const source = { id: "a".repeat(64), label: "Accepted bakery sketch", width: 64, height: 96, origin: { kind: "saved_world_image" } };
  fetcher.mockImplementation(async (url, opts) => {
    if (url.endsWith("/sources")) return Response.json({ sources: [source], nodes: [] });
    if (!opts?.body) return Response.json({ jobs: [], capabilities: config, image_capabilities: { ...config, model: MESH_IMAGE_MODEL, reservation: 1 } });
    return Response.json({ job: { ...job(), model: MESH_IMAGE_MODEL } });
  });
  draw(); await describe(); fireEvent.click(screen.getByRole("button", { name: "Image" }));
  await screen.findByRole("option", { name: source.label }); expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText("Concept image"), { target: { value: `source:${source.id}` } });
  expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/world/world/meshes/sources/${source.id}`);
  fireEvent.change(screen.getByLabelText("Mesh asset name"), { target: { value: "Bakery reference" } });
  expect(writes()).toEqual([]); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Generate mesh" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({ model: MESH_IMAGE_MODEL, source_id: source.id, reservation: 1, prompt: "Bakery reference", confirmed: true });
  expect(writes()[0]).not.toHaveProperty("input_image_url");
});
it("does not let a previous selected image generate while a new concept is being saved", async () => {
  const source = { id: "a".repeat(64), label: "First concept", width: 64, height: 64, origin: { kind: "imported_reference" } };
  let finish!: (r: Response) => void;
  fetcher.mockImplementation(async (url, opts) => {
    if (url.endsWith("/sources")) return opts?.body ? new Promise(resolve => { finish = resolve; }) : Response.json({ sources: [source], nodes: [{ id: "next", label: "Next sketch" }] });
    return Response.json({ jobs: [], capabilities: config, image_capabilities: { ...config, model: MESH_IMAGE_MODEL } });
  });
  draw(); fireEvent.click(screen.getByRole("button", { name: "Image" })); await screen.findByRole("option", { name: source.label });
  fireEvent.change(screen.getByLabelText("Concept image"), { target: { value: `source:${source.id}` } }); fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Concept image"), { target: { value: "node:next" } });
  expect((screen.getByRole("button", { name: "Generate mesh" }) as HTMLButtonElement).disabled).toBe(true);
  finish(Response.json({ source: { ...source, id: "b".repeat(64) } })); await screen.findByRole("img");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
});
