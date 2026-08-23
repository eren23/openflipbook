import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import TourButton from "./tour-button";

const NODES = [
  {
    id: "root",
    parent_id: null,
    page_title: "The Map",
    image_url: "https://r2/root.jpg",
    click_in_parent: null,
    relation: null,
    created_at: "2026-01-01",
  },
];

afterEach(() => vi.unstubAllGlobals());

describe("TourButton", () => {
  it("fetches the session graph once and opens the player", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ nodes: NODES, next_cursor: null }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TourButton sessionId="s1" continueUrl="/play?continue=s1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "▶ tour" }));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1?limit=200",
      expect.anything()
    );
    expect(screen.getByTestId("tour-player")).toBeTruthy();
  });

  it("follows the cursor so big worlds tour whole (no silent 200 cap)", async () => {
    const page2 = [{ ...NODES[0], id: "root2", parent_id: null }];
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("cursor=")
          ? { nodes: page2, next_cursor: null }
          : { nodes: NODES, next_cursor: "2026|root" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TourButton sessionId="s1" continueUrl="/play?continue=s1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "▶ tour" }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/sessions/s1?limit=200&cursor=2026%7Croot",
      expect.anything()
    );
    // Both pages' roots are in the running tour (2 steps counted).
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("stays closed when the graph fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    render(<TourButton sessionId="s1" continueUrl="/play?continue=s1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "▶ tour" }));
    });
    expect(screen.queryByTestId("tour-player")).toBeNull();
  });
});
