import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Entity } from "@openflipbook/config";

import { EntityHoverOverlay } from "./EntityHoverOverlay";

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: overrides.id ?? "e1",
    kind: overrides.kind ?? "person",
    name: overrides.name ?? "Mira",
    aliases: overrides.aliases ?? [],
    appearance: overrides.appearance ?? "tall keeper in navy coat",
    reference_image_url: overrides.reference_image_url ?? null,
    facts: overrides.facts ?? [],
    state: overrides.state ?? {},
    first_seen_node_id: overrides.first_seen_node_id ?? "n1",
    last_seen_node_id: overrides.last_seen_node_id ?? "n1",
    appears_on_node_ids: overrides.appears_on_node_ids ?? ["n1"],
    appearance_bboxes: overrides.appearance_bboxes ?? {},
    pinned_by_user: overrides.pinned_by_user ?? false,
    confidence: overrides.confidence ?? 0.8,
    updated_at: overrides.updated_at ?? "2026-05-17T00:00:00Z",
  };
}

describe("EntityHoverOverlay", () => {
  it("renders nothing when disabled", () => {
    const { container } = render(
      <EntityHoverOverlay
        nodeId="n1"
        entities={[
          entity({
            appearance_bboxes: {
              n1: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.2, h_pct: 0.2 },
            },
          }),
        ]}
        enabled={false}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when nodeId is null", () => {
    const { container } = render(
      <EntityHoverOverlay
        nodeId={null}
        entities={[
          entity({
            appearance_bboxes: {
              n1: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.2, h_pct: 0.2 },
            },
          }),
        ]}
        enabled
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("skips entities with no bbox for the current node", () => {
    const { container } = render(
      <EntityHoverOverlay
        nodeId="n1"
        entities={[entity({ appearance_bboxes: {} })]}
        enabled
      />
    );
    // Overlay container DOES NOT render at all when there's nothing to
    // show — keeps the DOM clean and avoids an empty z-index layer
    // intercepting nothing on top of the image.
    expect(container.firstChild).toBeNull();
  });

  it("renders a chip per entity with a bbox on the current node", () => {
    render(
      <EntityHoverOverlay
        nodeId="n1"
        entities={[
          entity({
            id: "a",
            name: "Mira",
            appearance_bboxes: {
              n1: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.2, h_pct: 0.2 },
            },
          }),
          entity({
            id: "b",
            name: "Lantern",
            kind: "item",
            appearance_bboxes: {
              n1: { x_pct: 0.5, y_pct: 0.5, w_pct: 0.1, h_pct: 0.1 },
            },
          }),
          entity({
            id: "c",
            name: "Off-screen",
            appearance_bboxes: {
              n2: { x_pct: 0.5, y_pct: 0.5, w_pct: 0.1, h_pct: 0.1 },
            },
          }),
        ]}
        enabled
      />
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Entity: Mira");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Entity: Lantern");
  });

  it("fires onSelect with the entity id when a chip is clicked", () => {
    const onSelect = vi.fn();
    render(
      <EntityHoverOverlay
        nodeId="n1"
        entities={[
          entity({
            id: "a",
            name: "Mira",
            appearance_bboxes: {
              n1: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.2, h_pct: 0.2 },
            },
          }),
        ]}
        enabled
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Mira/i }));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("reveals the peek card on hover", () => {
    render(
      <EntityHoverOverlay
        nodeId="n1"
        entities={[
          entity({
            id: "a",
            name: "Mira",
            appearance: "tall keeper",
            state: { lantern: "lit" },
            appearance_bboxes: {
              n1: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.2, h_pct: 0.2 },
            },
          }),
        ]}
        enabled
      />
    );
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Mira/i }));
    expect(screen.getByText("Mira")).toBeTruthy();
    expect(screen.getByText("tall keeper")).toBeTruthy();
    expect(screen.getByText("lantern: lit")).toBeTruthy();
  });

  it("skips stale stub entries (no appearance, no facts)", () => {
    // Optimistic stubs from extraction_event have empty appearance + no
    // facts. The codex shows them as resolving; the in-image overlay
    // should not show a chip until the refetch fills them in.
    const { container } = render(
      <EntityHoverOverlay
        nodeId="n1"
        entities={[
          entity({
            id: "a",
            appearance: "",
            facts: [],
            appearance_bboxes: {
              n1: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.2, h_pct: 0.2 },
            },
          }),
        ]}
        enabled
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
