import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorldEntityGeo } from "@openflipbook/config";

import WorldMiniMap from "./WorldMiniMap";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function ent(id: string, label: string, x: number, y: number): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label,
    pos: { x, y },
    height: 4,
    footprint: { w: 6, d: 6 },
    visual: "",
    state: {},
    confidence: 1,
    source: "derived",
    updated_at: "t",
  };
}

function mapPayload(entities: WorldEntityGeo[]) {
  return {
    session_id: "s1",
    entities,
    bounds: { x: 0, y: 0, w: 100, h: 60 },
    schema_version: 1,
    updated_at: "t",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("WorldMiniMap", () => {
  it("renders a dot per entity + the coordinate frame (origin)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok(mapPayload([ent("a", "University", 20, 15), ent("b", "Bridge", 50, 30)])),
      ) as unknown as typeof fetch,
    );
    render(<WorldMiniMap sessionId="s1" />);
    await waitFor(() => expect(screen.getByTestId("world-minimap")).toBeTruthy());
    expect(screen.getAllByTestId("minimap-dot")).toHaveLength(2);
    expect(screen.getByText("0,0")).toBeTruthy(); // the origin marker
    expect(screen.getByText(/world coords/i)).toBeTruthy();
  });

  it("renders nothing when the world is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(mapPayload([]))) as unknown as typeof fetch,
    );
    render(<WorldMiniMap sessionId="s1" />);
    await waitFor(() => undefined);
    expect(screen.queryByTestId("world-minimap")).toBeNull();
  });
});
