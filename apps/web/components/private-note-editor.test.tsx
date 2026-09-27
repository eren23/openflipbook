/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivateNoteEditor from "./private-note-editor";
import CreatorNotebook from "./creator-notebook";
import PlaceInspector from "./PlayPage/PlaceInspector";
const note = (text = "saved", revision = 1) => ({ place_id: null, label: "World notes", text, revision, updated_at: "2026-09-09T00:00:00Z" });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("private note editor", () => {
  it("loads, reports dirty state, saves plain text, and installs an unload guard", async () => {
    const changed = vi.fn(), saved = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ notes: [note()] })).mockResolvedValueOnce(json({ note: note("<b>private</b>", 2) })); vi.stubGlobal("fetch", fetcher);
    render(<PrivateNoteEditor sessionId="s1" onDirtyChange={changed} onSaved={saved} />);
    const input = await screen.findByRole("textbox", { name: "Private notes" });
    expect((input as HTMLTextAreaElement).value).toBe("saved");
    fireEvent.change(input, { target: { value: "<b>private</b>" } });
    expect(changed).toHaveBeenLastCalledWith(true);
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ place_id: null, text: "<b>private</b>", revision: 1 });
    expect(screen.queryByText("Unsaved changes")).toBeNull(); expect(screen.queryByRole("strong")).toBeNull();
  });
  it("keeps a failed-save draft and retries without discarding it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ notes: [] })).mockResolvedValueOnce(json({ error: "Unavailable" }, 503)).mockResolvedValueOnce(json({ note: note("draft") })));
    render(<PrivateNoteEditor sessionId="s1" />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "draft" } }); fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Unavailable"); expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("draft");
    fireEvent.click(screen.getByRole("button", { name: "Save note" })); await screen.findByText("Saved");
  });
  it("shows conflicting versions and requires an explicit choice before overwriting", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ notes: [note()] })).mockResolvedValueOnce(json({ error: "Conflict" }, 409)).mockResolvedValueOnce(json({ notes: [note("other tab", 2)] })).mockResolvedValueOnce(json({ note: note("my draft", 3) })); vi.stubGlobal("fetch", fetcher);
    render(<PrivateNoteEditor sessionId="s1" />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "my draft" } }); fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await screen.findByText("other tab"); expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("my draft"); expect((screen.getByRole("button", { name: "Save note" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep my draft" })); fireEvent.click(screen.getByRole("button", { name: "Save note" })); await screen.findByText("Saved");
    expect(JSON.parse(fetcher.mock.calls[3]?.[1].body).revision).toBe(2);
  });
  it("can discard a conflicting draft only after confirmation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ notes: [note()] })).mockResolvedValueOnce(json({ error: "Conflict" }, 409)).mockResolvedValueOnce(json({ notes: [note("remote", 2)] })));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<PrivateNoteEditor sessionId="s1" />); fireEvent.change(await screen.findByRole("textbox"), { target: { value: "draft" } }); fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use saved version" })); expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("draft");
    fireEvent.click(screen.getByRole("button", { name: "Use saved version" })); expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("remote"); expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("does not expose an editor after denied access, and recovers from load failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ error: "Forbidden" }, 403)).mockResolvedValueOnce(json({ notes: [] })));
    render(<PrivateNoteEditor sessionId="s1" />); await screen.findByText("Forbidden"); expect(screen.queryByRole("textbox")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByRole("textbox");
  });
});
describe("notebook navigation", () => {
  it("keeps missing-place entries and guards close, escape and entry switching", async () => {
    const notes = [note(), { ...note("orphan"), place_id: "gone", label: "Old dock", missing_place: true }];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(json({ notes }))));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false), close = vi.fn();
    render(<CreatorNotebook sessionId="s1" title="Harbor" onClose={close} />);
    await screen.findByRole("button", { name: "Old dock (place unavailable)" });
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Close notebook" })); fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Old dock (place unavailable)" })); expect(close).not.toHaveBeenCalled(); expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("draft");
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole("button", { name: "Old dock (place unavailable)" })); await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("orphan"));
    fireEvent.click(screen.getByRole("button", { name: "Close notebook" })); expect(close).toHaveBeenCalledTimes(1);
  });
  it("offers place notes only to owners and guards switching away", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(json({ notes: [] }))));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false), select = vi.fn();
    const props = { sessionId: "s1", places: [{ id: "p1", label: "Market", updated_at: "v1" }, { id: "p2", label: "Tower", updated_at: "v1" }] as any, pages: [], selectedId: "p1", onSelect: select, onClose: vi.fn(), onOpen: vi.fn(), onEnter: vi.fn(), onSaved: vi.fn(), busy: false };
    const view = render(<PlaceInspector {...props} />); expect(screen.queryByRole("tab", { name: "Notes" })).toBeNull();
    view.rerender(<PlaceInspector {...props} notesEnabled />); fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Private notes" }), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Details" })); fireEvent.click(screen.getByRole("button", { name: "Tower" })); expect(select).not.toHaveBeenCalled();
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole("tab", { name: "Details" })); expect(screen.queryByRole("textbox", { name: "Private notes" })).toBeNull();
    await act(async () => {});
  });
});
