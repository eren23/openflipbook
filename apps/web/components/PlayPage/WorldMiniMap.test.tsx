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

function childEnt(
  id: string,
  label: string,
  x: number,
  y: number,
  parentId: string,
): WorldEntityGeo {
  return { ...ent(id, label, x, y), parent_id: parentId };
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

  it("scopes to the entered place's LOCAL frame when focusId is set", async () => {
    // University at city coords (50,30); its interior parts carry pos LOCAL to
    // its frame (small, near the local origin). The inset must show the parts,
    // in local coords — not the whole city.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok(
          mapPayload([
            ent("u", "University", 50, 30),
            childEnt("t", "Tower of Art", 2, 1, "u"),
            childEnt("l", "Library", -3, 0, "u"),
          ]),
        ),
      ) as unknown as typeof fetch,
    );
    render(<WorldMiniMap sessionId="s1" focusId="u" focusLabel="University" />);
    await waitFor(() => expect(screen.getByTestId("world-minimap")).toBeTruthy());
    // the 2 interior parts, not the city's 3 entities
    expect(screen.getAllByTestId("minimap-dot")).toHaveLength(2);
    expect(screen.getByText(/inside University/i)).toBeTruthy();
    expect(screen.getByText(/local coords/i)).toBeTruthy();
    // the lie we're killing: it must NOT claim the city's frame
    expect(screen.queryByText(/world coords/i)).toBeNull();
    expect(screen.queryByText(/100×60/)).toBeNull();
  });

  it("shows an explicit empty-state (not the city) for a place with no interior yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok(
          mapPayload([
            ent("u", "University", 50, 30),
            ent("b", "Bridge", 80, 40),
          ]),
        ),
      ) as unknown as typeof fetch,
    );
    render(<WorldMiniMap sessionId="s1" focusId="u" focusLabel="University" />);
    await waitFor(() => expect(screen.getByTestId("minimap-empty")).toBeTruthy());
    expect(screen.queryAllByTestId("minimap-dot")).toHaveLength(0);
    expect(screen.queryByText(/world coords/i)).toBeNull();
  });
});
