import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import PlaceSceneEdits from "./place-scene-edits";
const fetcher = vi.fn(), onProposal = vi.fn(), onPendingChange = vi.fn();
const capabilities = { enabled: true, model: "model", reservation: 0.2 };
const props = { sessionId: "world", placeId: "place", baseRevision: 1, selectedObjectId: "inn", disabled: false, onProposal, onPendingChange };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetcher); });
it("requires quoted consent and retries identical frozen scope after a lost acknowledgement", async () => {
  const bodies: string[] = []; let lost = true;
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return Response.json({ jobs: [], capabilities });
    bodies.push(String(init.body)); if (lost) { lost = false; throw new Error("Lost acknowledgement"); }
    return Response.json({ job: { id: "job", prompt: "Paint teal", model: "model", reservation: 0.2, base_revision: 1, selected_object_ids: ["inn"], status: "ready", created_at: "2026-10-03" } });
  });
  const view = render(<PlaceSceneEdits {...props}/>); await screen.findByText("Reserve $0.20 for one edit proposal");
  fireEvent.change(screen.getByLabelText("Scene edit description"), { target: { value: "Paint teal" } });
  expect((screen.getByRole("button", { name: "Generate edit proposal" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Generate edit proposal" })); await screen.findByText("Lost acknowledgement");
  expect(onPendingChange).toHaveBeenLastCalledWith(true);
  view.rerender(<PlaceSceneEdits {...props} baseRevision={2} selectedObjectId="oak" disabled/>);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved edit request" }));
  await waitFor(() => expect(bodies).toHaveLength(2)); expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[0]!)).toMatchObject({ base_revision: 1, selected_object_ids: ["inn"], confirmed: true });
  await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false)); expect((screen.getByRole("button", { name: "Preview saved edit" }) as HTMLButtonElement).disabled).toBe(true);
});
it("loads a saved completed response and previews it without quote consent or another planning call", async () => {
  const proposal = { id: "saved-proposal", scene_id: "scene", base_revision: 1, definition: {}, affected_node_ids: [], changes: ["Paint Inn"] };
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => Response.json(init?.method ? { proposal } : { capabilities: { enabled: false, reason: "Backend offline" }, jobs: [{ id: "old-job", prompt: "Paint teal", model: "model", reservation: 0.2, base_revision: 1, selected_object_ids: ["inn"], status: "ready", created_at: "2026-10-03" }] }));
  render(<PlaceSceneEdits {...props}/>); fireEvent.click(await screen.findByRole("button", { name: "Preview saved edit" }));
  await waitFor(() => expect(onProposal).toHaveBeenCalledWith(proposal));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init.body))).toEqual([{ action: "preview", id: "old-job" }]);
});
it("retains ambiguous job status and offers discard while creating no automatic retry", async () => {
  fetcher.mockResolvedValue(Response.json({ capabilities, jobs: [{ id: "unknown", prompt: "Paint teal", model: "model", reservation: 0.2, base_revision: 1, selected_object_ids: ["inn"], status: "submission_unknown", created_at: "2026-10-03", error: "May be billable; no automatic retry" }] }));
  render(<PlaceSceneEdits {...props}/>); await screen.findByText("submission unknown");
  expect(screen.getByRole("button", { name: "Cancel scene edit job" })).toBeTruthy(); expect(screen.queryByRole("button", { name: "Preview saved edit" })).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
});
it("refreshes a saved review without generation and retains its review ID after a lost acknowledgement", async () => {
  const bodies: string[] = []; let lost = true;
  const proposal = { id: "refreshed", scene_id: "scene", base_revision: 1, definition: {}, affected_node_ids: [], changes: ["Paint Inn"] };
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return Response.json({ capabilities, jobs: [{ id: "job", prompt: "Paint teal", model: "model", reservation: 0.2, base_revision: 1, selected_object_ids: ["inn"], status: "ready", created_at: "2026-10-03" }] });
    bodies.push(String(init.body)); if (lost) { lost = false; throw new Error("Lost free review acknowledgement"); } return Response.json({ proposal });
  });
  const view = render(<PlaceSceneEdits {...props}/>); fireEvent.click(await screen.findByRole("button", { name: "Refresh saved edit review" })); await screen.findByText("Lost free review acknowledgement");
  view.rerender(<PlaceSceneEdits {...props} disabled/>); fireEvent.click(screen.getByRole("button", { name: "Retry saved review" }));
  await waitFor(() => expect(onProposal).toHaveBeenCalledWith(proposal)); expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[0]!)).toMatchObject({ action: "refresh-preview", id: "job" });
  expect(JSON.parse(bodies[0]!).review_id).toBeTruthy(); expect(onPendingChange).toHaveBeenLastCalledWith(false);
});
