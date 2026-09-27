import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreatorWorkspace from "./creator-workspace";
vi.mock("./creator-notebook", () => ({ default: ({ title, onClose }: { title: string; onClose: () => void }) => <div role="dialog" aria-label={title}><button onClick={onClose}>Close notebook</button></div> }));
const world = { id: "s1", title: "Harbor", image_url: "/saved.jpg", node_count: 2, pinned: false, archived: false, last_opened_at: "2026-09-09T00:00:00Z", resume_node_id: "n1" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("creator workspace", () => {
  it("loads saved artwork and resume links, opens notebook, and recovers missing previews", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(json({ worlds: [world], next_cursor: null }))));
    render(<CreatorWorkspace />); await screen.findByRole("article");
    expect(screen.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe("/play?continue=s1&node=n1");
    fireEvent.error(screen.getByRole("img", { name: "Harbor" })); expect(screen.getByLabelText("Preview unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open notebook" })); expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close notebook" })); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("pins, renames, archives and restores with metadata-only requests", async () => {
    let current = { ...world };
    const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") { current = { ...current, ...JSON.parse(String(init.body)) }; return json({ saved: true }); }
      const archive = new URL(url, "http://local").searchParams.get("archived") === "true";
      return json({ worlds: current.archived === archive ? [current] : [], next_cursor: null });
    }); vi.stubGlobal("fetch", fetcher); render(<CreatorWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Pin world" })); await screen.findByRole("button", { name: "Unpin world" });
    fireEvent.click(screen.getByRole("button", { name: "Rename world" })); fireEvent.change(screen.getByRole("textbox", { name: "World title" }), { target: { value: "New harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel rename" })); expect(screen.getByRole("heading", { name: "Harbor" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename world" })); fireEvent.change(screen.getByRole("textbox", { name: "World title" }), { target: { value: "New harbor" } }); fireEvent.click(screen.getByRole("button", { name: "Save title" })); await screen.findByRole("heading", { name: "New harbor" });
    fireEvent.click(screen.getByRole("button", { name: "Archive world" })); await screen.findByText("No saved worlds in this browser");
    fireEvent.click(screen.getByRole("tab", { name: "Archived" })); fireEvent.click(await screen.findByRole("button", { name: "Restore world" })); await screen.findByText("No archived worlds");
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/creator/"))).toBe(true);
  });
  it("paginates and resets the result set when search changes", async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => {
      const params = new URL(url, "http://local").searchParams;
      if (params.get("q")) return json({ worlds: [], next_cursor: null });
      return params.get("cursor") ? json({ worlds: [{ ...world, id: "s2", title: "Tower", image_url: null, node_count: 1 }], next_cursor: null }) : json({ worlds: [world], next_cursor: "20" });
    }); vi.stubGlobal("fetch", fetcher); render(<CreatorWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" })); await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    fireEvent.change(screen.getByRole("textbox", { name: "Search worlds" }), { target: { value: "unknown" } }); await screen.findByText("No matching worlds"); expect(screen.queryByRole("article")).toBeNull();
  });
  it("reports load, configuration and mutation errors with recovery", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: "Unavailable" }, 503)).mockResolvedValueOnce(json({ worlds: [world], next_cursor: null })).mockResolvedValueOnce(json({ error: "Save failed" }, 503)); vi.stubGlobal("fetch", fetcher);
    const view = render(<CreatorWorkspace />); await screen.findByText("Unavailable"); fireEvent.click(screen.getByRole("button", { name: "Retry" })); fireEvent.click(await screen.findByRole("button", { name: "Pin world" })); await screen.findByText("Save failed");
    view.unmount(); fetcher.mockResolvedValue(json({ error: "Persistence is not configured" }, 503)); render(<CreatorWorkspace />); await screen.findByRole("link", { name: "Open status" });
  });
});
