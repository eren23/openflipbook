import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorldEntityGeo } from "@openflipbook/config";
import type { Page } from "@/lib/session-pages";
import PlaceInspector from "./PlaceInspector";

const place: WorldEntityGeo = { id: "tower", entity_id: null, kind: "place", label: "North Tower", visual: "Granite", pos: { x: 30, y: 20 }, footprint: { w: 5, d: 5 }, height: 8, state: {}, confidence: 1, source: "user", updated_at: "2026-09-06T00:00:00.000Z" };
const page: Page = { nodeId: "root", sessionId: "world", title: "The coast", imageDataUrl: "data:image/png;base64,c2F2ZWQ=", query: "coast", sources: [], sceneView: { node_id: "root", level: "building", observer: null, map_crop: null, focus_id: "tower" } };
const props = () => ({ sessionId: "world", places: [place], pages: [page], selectedId: "tower", onSelect: vi.fn(), onClose: vi.fn(), onOpen: vi.fn(), onEnter: vi.fn(), onSaved: vi.fn(async () => {}), busy: false });
afterEach(() => vi.unstubAllGlobals());

describe("Place inspector", () => {
  it("searches, selects and restores focus after closing", () => {
    const p = props();
    render(<PlaceInspector {...p} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Close place inspector"));
    fireEvent.click(screen.getByRole("button", { name: "North Tower" }));
    expect(p.onSelect).toHaveBeenCalledWith("tower");
    fireEvent.change(screen.getByLabelText("Search places"), { target: { value: "absent" } });
    expect(screen.queryByRole("button", { name: "North Tower" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalled();
  });
  it("saves a locked identity and crop with a version, never an image key", async () => {
    const p = props();
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ place: { ...place, updated_at: "2026-09-07T00:00:00.000Z" } }) }));
    vi.stubGlobal("fetch", fetcher);
    render(<PlaceInspector {...p} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Beacon" } });
    fireEvent.change(screen.getByLabelText("Appearance"), { target: { value: "White granite" } });
    fireEvent.click(screen.getByLabelText("Lock identity"));
    fireEvent.change(screen.getByLabelText("Reference image"), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText("Reference width percent"), { target: { value: "50" } });
    fireEvent.click(screen.getByLabelText("Save place"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ expected_updated_at: place.updated_at, label: "Beacon", visual: "White granite", identity_locked: true, reference: { node_id: "root", bbox: { x_pct: 0, y_pct: 0, w_pct: .5, h_pct: 1 } } });
    expect(p.onSaved).toHaveBeenCalledOnce();
  });
  it("rejects out-of-bounds crop input before sending a request", () => {
    render(<PlaceInspector {...props()} />);
    fireEvent.change(screen.getByLabelText("Reference image"), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText("Reference left percent"), { target: { value: "80" } });
    expect((screen.getByLabelText("Save place") as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps stale edits visible and reloads the place without navigating away", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "Place changed; reload it" }) })));
    const p = props();
    render(<PlaceInspector {...p} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByLabelText("Save place"));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Unsaved");
    fireEvent.click(screen.getByText("Reload place"));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(place.label));
    expect(p.onSaved).toHaveBeenCalledOnce();
  });
  it("opens saved views separately from requesting a new view", () => {
    const p = props(); render(<PlaceInspector {...p} />);
    fireEvent.click(screen.getByTitle("Open saved view: The coast"));
    expect(p.onOpen).toHaveBeenCalledWith("root");
    fireEvent.click(screen.getByText("Enter")); fireEvent.click(screen.getByText("New view"));
    expect(p.onEnter.mock.calls).toEqual([[place, false], [place, true]]);
  });
  it("uses the immutable saved reference when the node has since been edited", () => {
    render(<PlaceInspector {...props()} places={[{ ...place, identity_locked: true, identity_anchor: { node_id: "root", image_key: "original.png", bbox: { x_pct: 0, y_pct: 0, w_pct: 1, h_pct: 1 } } }]} />);
    expect(screen.getByAltText("Place reference").getAttribute("src")).toContain("/api/world/world/places/tower?v=");
  });
  it("aborts an in-flight save when the inspector is dismissed", () => {
    const fetcher = vi.fn(() => new Promise(() => {})); vi.stubGlobal("fetch", fetcher);
    const { unmount } = render(<PlaceInspector {...props()} />);
    fireEvent.click(screen.getByLabelText("Save place"));
    const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    unmount(); expect(signal.aborted).toBe(true);
  });
  it("renders an empty world without offering generation", () => {
    render(<PlaceInspector {...props()} places={[]} />);
    expect(screen.getByText("No mapped places")).toBeTruthy();
    expect(screen.queryByText("Enter")).toBeNull();
  });
});
