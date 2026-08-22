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
      json: async () => ({ nodes: NODES }),
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

  it("stays closed when the graph fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    render(<TourButton sessionId="s1" continueUrl="/play?continue=s1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "▶ tour" }));
    });
    expect(screen.queryByTestId("tour-player")).toBeNull();
  });
});
