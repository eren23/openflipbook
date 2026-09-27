import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SavedPlaceView } from "@/lib/place-view";
import type { MotionReferenceCapture } from "./camera-motion-capture";
import MotionStudyLibrary from "./motion-study-library";
vi.mock("./motion-generation", () => ({ default: () => null }));
const view = { id: "view", label: "Inn", width: 64, height: 32, historical: false } as SavedPlaceView;
const reference = { preparation_sha256: "frozen", preflight: { status: "blocked", samples: 12, clearance: .2, visibility: "sampled", issues: [{ kind: "collision", time: .25, end_time: .5 }] }, frames: [{ time: 0, seconds: 0, capture: { original: true } }] } as unknown as MotionReferenceCapture;
const study = { id: "study", label: "Inn motion", historical: false, frames: [{ time: 0, seconds: 0 }, { time: 1, seconds: 6 }] };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json({ studies: [] }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("reopens saved references with reads only and scrubs their private image URLs", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ studies: [study] }));
  render(<MotionStudyLibrary sessionId="world" view={view} reference={null} disabled={false}/>);
  await screen.findByRole("slider", { name: "Saved motion reference time" });
  fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } });
  expect(new URL((screen.getByAltText("Saved motion reference at 6.00 seconds") as HTMLImageElement).src).pathname).toBe("/api/world/world/motion-studies/study/1/render");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Save motion study" })).toBeNull();
});
it("retains the exact payload after a lost response despite reference changes", async () => {
  let lose = true;
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    if (options?.method !== "POST") return Response.json({ studies: lose ? [] : [study] });
    if (lose) { lose = false; throw new Error("Response lost"); }
    return Response.json({ id: "study" });
  });
  const ui = render(<MotionStudyLibrary sessionId="world" view={view} reference={reference} disabled={false}/>);
  fireEvent.click(screen.getByRole("button", { name: "Save motion study" }));
  await screen.findByText("Response lost");
  ui.rerender(<MotionStudyLibrary sessionId="world" view={view} reference={{ ...reference, preparation_sha256: "changed" }} disabled={false}/>);
  fireEvent.click(screen.getByRole("button", { name: "Retry motion study save" }));
  await screen.findByRole("slider", { name: "Saved motion reference time" });
  const writes = vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === "POST");
  expect(writes).toHaveLength(2); expect(writes[0]![1]!.body).toBe(writes[1]![1]!.body);
  expect(JSON.parse(String(writes[1]![1]!.body)).preparation_sha256).toBe("frozen");
  expect(JSON.parse(String(writes[1]![1]!.body)).client_preflight).toEqual(reference.preflight);
});
it("shows saving while a write is pending and preserves blocked reports on reopen", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "POST"
    ? new Promise<Response>(done => { resolve = done; }) : Response.json({ studies: [{ ...study, client_preflight: reference.preflight }] }));
  render(<MotionStudyLibrary sessionId="world" view={view} reference={reference} disabled={false}/>);
  await screen.findByText("Local path check: blocked / not server verified");
  expect(screen.getByText("Collision: 1.50s - 3.00s")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save motion study" }));
  expect((screen.getByRole("button", { name: "Saving motion study..." }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Retry motion study save" })).toBeNull();
  resolve(Response.json({ id: "study" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Save motion study" }) as HTMLButtonElement).disabled).toBe(false));
});
it("blocks fresh saves of dirty sources while allowing historical saved references", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ studies: [{ ...study, historical: true }] }));
  render(<MotionStudyLibrary sessionId="world" view={view} reference={reference} disabled={true}/>);
  await screen.findByText("Saved geometry reference / Historical source");
  expect((screen.getByRole("button", { name: "Save motion study" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save motion study" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
});
