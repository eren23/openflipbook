import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlaceViewLibrary from "./place-view-library";
import type { SavedPlaceView } from "@/lib/place-view";

vi.mock("./illustration-region-picker", () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("defers a prepared camera selection until the prior illustration's exact lost acknowledgement is recovered", async () => {
  const prior = { id: "prior", label: "Prior camera", mode: "walk", width: 400, height: 300, historical: false } as SavedPlaceView;
  const first = { ...prior, id: "first", label: "Walk checkpoint 1/2" };
  let views = [prior]; const posted: { url: string; body: string }[] = [], pending = vi.fn();
  const library = { jobs: [], assets: [], accepted_id: null, historical: false, capabilities: { enabled: true, model: "fixture", reservation: .1, parameters: {} } };
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push({ url, body: String(init.body) });
      if (posted.length === 1) throw new Error("Illustration acknowledgement lost");
      return Response.json({});
    }
    return Response.json(url.includes("/illustrations") ? library : { views });
  }));
  const ui = render(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={null} disabled={false} onPendingChange={pending}/>);
  await screen.findByRole("checkbox", { name: "Reserve $0.10 for this illustration" });
  fireEvent.change(screen.getByRole("textbox", { name: "Illustration appearance" }), { target: { value: "Keep this world's inked stone" } });
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Generate illustration" }));
  await screen.findByText("Illustration acknowledgement lost"); expect(pending).toHaveBeenLastCalledWith(true);
  views = [first, prior];
  ui.rerender(<PlaceViewLibrary sessionId="world" placeId="place" revision={1} capture={null} disabled={false} selectedViewId="first" refreshKey={1} onPendingChange={pending}/>);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("?view=first"))).toBe(true));
  expect(screen.getByRole("combobox", { name: "Saved camera view" })).toHaveProperty("value", "prior");
  fireEvent.click(screen.getByRole("button", { name: "Retry illustration request" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Saved camera view" })).toHaveProperty("value", "first"));
  expect(posted).toHaveLength(2); expect(posted[1]).toEqual(posted[0]);
  expect(posted[0]!.url).toContain("/views/prior/illustrations");
});

it("keeps a manually selected camera after illustration acknowledgement and applies only a new external selection request", async () => {
  const first = { id: "first", label: "Walk checkpoint 1/2", mode: "walk", width: 400, height: 300, historical: false } as SavedPlaceView;
  const other = { ...first, id: "other", label: "Manual camera" }, pending = vi.fn();
  const library = { jobs: [], assets: [], accepted_id: null, historical: false, capabilities: { enabled: true, model: "fixture", reservation: .1, parameters: {} } };
  let acknowledge!: (response: Response) => void;
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: String(init.body) });
      return new Promise<Response>(resolve => { acknowledge = resolve; });
    }
    return Response.json(url.includes("/illustrations") ? library : { views: [first, other] });
  }));
  const props = { sessionId: "world", placeId: "place", revision: 1, capture: null, disabled: false, selectedViewId: "first", refreshKey: 1, onPendingChange: pending };
  const ui = render(<PlaceViewLibrary {...props}/>);
  await screen.findByRole("checkbox", { name: "Reserve $0.10 for this illustration" });
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Saved camera view" })).toHaveProperty("value", "first"));
  fireEvent.change(screen.getByRole("combobox", { name: "Saved camera view" }), { target: { value: "other" } });
  await screen.findByRole("checkbox", { name: "Reserve $0.10 for this illustration" });
  fireEvent.change(screen.getByRole("textbox", { name: "Illustration appearance" }), { target: { value: "Keep the selected camera's painted stone" } });
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Generate illustration" }));
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(true));
  expect(posts).toHaveLength(1); expect(posts[0]!.url).toContain("/views/other/illustrations");
  await act(async () => acknowledge(Response.json({})));
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  expect(screen.getByRole("combobox", { name: "Saved camera view" })).toHaveProperty("value", "other");
  ui.rerender(<PlaceViewLibrary {...props} refreshKey={2}/>);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Saved camera view" })).toHaveProperty("value", "first"));
  expect(posts).toHaveLength(1);
});
