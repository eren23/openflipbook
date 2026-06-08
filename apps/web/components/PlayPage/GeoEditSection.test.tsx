import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import GeoEditSection from "./GeoEditSection";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function mapPayload() {
  return {
    session_id: "s1",
    entities: [
      {
        id: "g1",
        entity_id: "g1",
        kind: "place",
        label: "lighthouse",
        pos: { x: 40, y: 10 },
        height: 12,
        footprint: { w: 6, d: 6 },
        visual: "",
        state: {},
        confidence: 1,
        source: "user",
        updated_at: "t",
      },
    ],
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    schema_version: 1,
    updated_at: "t",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("GeoEditSection", () => {
  it("hydrates the map chips and previews edits with dry_run", async () => {
    const plan = {
      edits: [{ op: "move", target: "g1", dx: 0, dy: -5 }],
      blast_radius: ["n1"],
    };
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      String(url).includes("/edit-entities") ? ok({ plan }) : ok(mapPayload()),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<GeoEditSection sessionId="s1" />);
    await waitFor(() =>
      expect(screen.getByTestId("geo-chips").textContent).toContain("lighthouse"),
    );

    fireEvent.change(screen.getByLabelText(/natural-language map edit/i), {
      target: { value: "move the lighthouse north" },
    });
    fireEvent.click(screen.getByText(/preview edit/i));
    await waitFor(() => screen.getByTestId("confirm"));

    const editCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/edit-entities"),
    );
    expect(editCall).toBeTruthy();
    const sentBody = JSON.parse(String((editCall![1] as RequestInit).body));
    expect(sentBody.dry_run).toBe(true);
    expect(sentBody.instruction).toBe("move the lighthouse north");
  });
});
