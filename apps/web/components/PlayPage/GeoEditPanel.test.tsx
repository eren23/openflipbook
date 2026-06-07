import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EntityEditPlan, WorldEntityGeo } from "@openflipbook/config";

import GeoEditPanel from "./GeoEditPanel";

function geo(id: string, label: string, x: number, y: number): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label,
    pos: { x, y },
    height: 5,
    footprint: { w: 6, d: 6 },
    visual: "",
    state: {},
    confidence: 1,
    source: "user",
    updated_at: "t",
  };
}

describe("GeoEditPanel", () => {
  it("renders a chip per entity", () => {
    render(<GeoEditPanel entities={[geo("g1", "lighthouse", 40, 10)]} onSubmit={vi.fn()} />);
    expect(screen.getByTestId("geo-chips").textContent).toContain("lighthouse");
  });

  it("P7e — nests a sub-entity under its place (shows 'in <place>')", () => {
    const uu = geo("uu", "Unseen University", 30, 18);
    const tower: WorldEntityGeo = { ...geo("tower", "Tower of Art", -8, -1), parent_id: "uu" };
    render(<GeoEditPanel entities={[tower, uu]} onSubmit={vi.fn()} />);
    const text = screen.getByTestId("geo-chips").textContent ?? "";
    expect(text).toContain("Tower of Art");
    expect(text).toContain("in Unseen University");
  });

  it("previews → shows the blast-radius confirm → applies", async () => {
    const plan: EntityEditPlan = {
      edits: [{ op: "move", target: "g1", dx: 0, dy: -5 }],
      blast_radius: ["n1", "n2"],
    };
    const onSubmit = vi.fn().mockResolvedValue(plan);
    render(<GeoEditPanel entities={[geo("g1", "lighthouse", 40, 10)]} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/natural-language map edit/i), {
      target: { value: "move the lighthouse north" },
    });
    fireEvent.click(screen.getByText(/preview edit/i));

    await waitFor(() => screen.getByTestId("confirm"));
    expect(screen.getByTestId("confirm").textContent).toContain("Restages 2 saved scenes");
    expect(onSubmit).toHaveBeenCalledWith("move the lighthouse north", true);

    fireEvent.click(screen.getByText(/^Apply/));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("move the lighthouse north", false),
    );
    // confirm clears after apply
    await waitFor(() => expect(screen.queryByTestId("confirm")).toBeNull());
  });

  it("an empty plan → friendly error, no confirm", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ edits: [], blast_radius: [] });
    render(<GeoEditPanel entities={[geo("g1", "x", 0, 0)]} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/natural-language map edit/i), {
      target: { value: "do nothing useful" },
    });
    fireEvent.click(screen.getByText(/preview edit/i));
    await waitFor(() => screen.getByTestId("geo-error"));
    expect(screen.getByTestId("geo-error").textContent).toMatch(/no change understood/i);
    expect(screen.queryByTestId("confirm")).toBeNull();
  });
});
