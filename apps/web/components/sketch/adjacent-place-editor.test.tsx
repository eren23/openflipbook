import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import AdjacentPlaceEditor from "./adjacent-place-editor";
import { emptyPlaceScene } from "@/lib/place-scene";
import type { PlaceSceneSnapshot } from "@openflipbook/config";
const scene: PlaceSceneSnapshot = { id: "scene", session_id: "world", place_id: "place", revision: 1, source_node_id: null, source_image_key: null, updated_at: "now", definition: emptyPlaceScene() };
const preview = { place_id: "next", proposal: { id: "proposal", definition: { label: "New yard" }, changes: ["Connect east boundary"] } };
const config = { enabled: true, model: "fixture", reservation: 0.2 };
const fetcher = vi.fn(), saved = vi.fn();
beforeEach(() => {
  fetcher.mockReset(); saved.mockReset(); saved.mockResolvedValue(undefined); vi.stubGlobal("fetch", fetcher);
  fetcher.mockImplementation(async (_url, options) => {
    if (!options?.body) return Response.json({ capabilities: config });
    const body = JSON.parse(options.body); return Response.json(body.action ? { place_id: "next" } : preview);
  });
});
const writes = () => fetcher.mock.calls.filter(([, o]) => o?.body).map(([, o]) => JSON.parse(o.body));
async function review(generation = true) {
  render(<AdjacentPlaceEditor scene={scene} disabled={false} onSaved={saved} onBusy={vi.fn()}/>);
  fireEvent.click(screen.getByText("Add adjoining area"));
  fireEvent.change(screen.getByLabelText("Adjoining area name"), { target: { value: "New yard" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview adjoining area" })); await screen.findByRole("region", { name: "Connection preview" });
  if (generation) {
    fireEvent.click(screen.getByRole("checkbox", { name: "Generate layout in new area" })); await screen.findByText("fixture");
    fireEvent.change(screen.getByLabelText("Adjoining area description"), { target: { value: "Two workshops" } });
  }
}
it("keeps manual expansion free and does not fetch generation config until requested", async () => {
  await review(false); expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Apply adjoining area" })); await waitFor(() => expect(saved).toHaveBeenCalledWith());
  expect(writes().map(w => w.action)).toEqual([undefined, "apply"]);
});
it.each([0.004,0.204])("shows the exact reservation without rounding away %s USD",async reservation=>{
  fetcher.mockImplementation(async(_url,options)=>Response.json(options?.body?preview:{capabilities:{...config,reservation}}));
  await review();expect(screen.getByRole("checkbox",{name:`Reserve $${reservation} for adjoining layout only`})).toBeTruthy();
  expect(writes()).toHaveLength(1);
});
it("requires reviewed geometry and explicit layout-only consent, then opens the created place with one generation request", async () => {
  await review(); expect((screen.getByRole("button", { name: "Create and generate" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Reserve $0.20 for adjoining layout only" }));
  fireEvent.click(screen.getByRole("button", { name: "Create and generate" })); await waitFor(() => expect(saved).toHaveBeenCalledWith("next"));
  expect(writes()).toHaveLength(2); expect(writes()[1]).toEqual({ action: "generate", place_id: "next", proposal_id: "proposal", prompt: "Two workshops", confirmed: true, model: "fixture", reservation: 0.2 });
});
it("locks an ambiguous request and retries identical inputs without another preview or id", async () => {
  await review(); fireEvent.click(screen.getByRole("checkbox", { name: "Reserve $0.20 for adjoining layout only" }));
  fetcher.mockRejectedValueOnce(new Error("Lost acknowledgement"));
  fireEvent.click(screen.getByRole("button", { name: "Create and generate" })); await screen.findByText("Lost acknowledgement");
  expect(screen.getByLabelText("Adjoining area name").closest("fieldset")!.disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved expansion" })); await waitFor(() => expect(saved).toHaveBeenCalledWith("next"));
  expect(writes()).toHaveLength(3); expect(writes()[1]).toEqual(writes()[2]);
});
it("retains the request when creation succeeded but loading its editor failed", async () => {
  await review(); fireEvent.click(screen.getByRole("checkbox", { name: "Reserve $0.20 for adjoining layout only" })); saved.mockRejectedValueOnce(new Error("Load failed"));
  fireEvent.click(screen.getByRole("button", { name: "Create and generate" })); await screen.findByText("Load failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry saved expansion" })); await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  expect(writes()[1]).toEqual(writes()[2]);
});
it("requires fresh consent after a quote rejection and after changing description or extent", async () => {
  await review(); const consent = () => screen.getByRole("checkbox", { name: "Reserve $0.20 for adjoining layout only" }); fireEvent.click(consent());
  fireEvent.change(screen.getByLabelText("Adjoining area description"), { target: { value: "A town hall" } }); expect((consent() as HTMLInputElement).checked).toBe(false); fireEvent.click(consent());
  fetcher.mockResolvedValueOnce(Response.json({ error: "Generation configuration changed" }, { status: 409 }));
  fireEvent.click(screen.getByRole("button", { name: "Create and generate" })); await screen.findByText("Generation configuration changed"); await screen.findByText("fixture");
  expect((consent() as HTMLInputElement).checked).toBe(false); expect(screen.getByLabelText("Adjoining area name").closest("fieldset")!.disabled).toBe(false);
  fireEvent.click(consent()); fireEvent.change(screen.getByLabelText("Adjoining width"), { target: { value: "60" } }); expect(screen.queryByRole("region", { name: "Connection preview" })).toBeNull(); expect((consent() as HTMLInputElement).checked).toBe(false);
});
