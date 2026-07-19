// DOM place-name labels: bbox-centred anchors beat geo fallback, map-frames
// only, pointer-events pass through, and %-positioning when no measured
// content rect exists (no imgRef here, so the percent fallback path).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Entity, SceneView, WorldEntityGeo } from "@openflipbook/config";

import { MapLabelOverlay } from "./MapLabelOverlay";

function entity(over: Partial<Entity> = {}): Entity {
  return {
    id: "e1",
    kind: "place",
    name: "Harbour",
    aliases: [],
    appearance: "stone harbour",
    reference_image_url: null,
    facts: [],
    state: {},
    first_seen_node_id: "n1",
    last_seen_node_id: "n1",
    appears_on_node_ids: ["n1"],
    appearance_bboxes: {
      n1: { x_pct: 0.2, y_pct: 0.3, w_pct: 0.2, h_pct: 0.2 },
    },
    pinned_by_user: false,
    confidence: 0.9,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function geo(over: Partial<WorldEntityGeo> = {}): WorldEntityGeo {
  return {
    id: "g1",
    entity_id: "e1",
    kind: "place",
    label: "Fort",
    pos: { x: 50, y: 30 },
    height: 5,
    footprint: { w: 4, d: 4 },
    visual: "star fort",
    state: {},
    confidence: 0.9,
    source: "extracted",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const mapView: SceneView = {
  node_id: "n1",
  level: "map",
  observer: null,
  map_crop: { x: 0, y: 0, w: 100, h: 60 },
};

describe("MapLabelOverlay", () => {
  it("labels codex entities at their bbox centres (percent fallback, click-through)", () => {
    const { container } = render(
      <MapLabelOverlay
        nodeId="n1"
        entities={[entity()]}
        geoEntities={[]}
        currentView={mapView}
      />,
    );
    const label = screen.getByText("Harbour");
    // Anchored from the bbox centre (0.3, 0.4): horizontally centred on 30%,
    // vertically just above 40% — positions come from props, not layout.
    const left = parseFloat(label.style.left);
    const top = parseFloat(label.style.top);
    expect(label.style.left.endsWith("%")).toBe(true);
    expect(left).toBeGreaterThan(20);
    expect(left).toBeLessThan(30);
    expect(top).toBeGreaterThan(30);
    expect(top).toBeLessThan(40);
    // The layer never eats a map click.
    const layer = container.firstElementChild as HTMLElement;
    expect(layer.className).toContain("pointer-events-none");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
  });

  it("bbox anchors win over the geo fallback when both exist", () => {
    render(
      <MapLabelOverlay
        nodeId="n1"
        entities={[entity()]}
        geoEntities={[geo()]}
        currentView={mapView}
      />,
    );
    expect(screen.getByText("Harbour")).toBeTruthy();
    expect(screen.queryByText("Fort")).toBeNull();
  });

  it("falls back to geo anchors mapped through the map frame", () => {
    render(
      <MapLabelOverlay
        nodeId="n1"
        entities={[]}
        geoEntities={[geo(), geo({ id: "g2", label: "", pos: { x: 10, y: 10 } })]}
        currentView={mapView}
      />,
    );
    // pos (50,30) in a 100×60 frame → mid-map label; the blank-label geo is culled.
    const label = screen.getByText("Fort");
    expect(parseFloat(label.style.left)).toBeGreaterThan(40);
    expect(parseFloat(label.style.left)).toBeLessThan(50);
    expect(document.querySelectorAll("[data-label-id]").length).toBe(1);
  });

  it("culls geo anchors that land outside the visible frame", () => {
    const { container } = render(
      <MapLabelOverlay
        nodeId="n1"
        entities={[]}
        geoEntities={[geo({ pos: { x: 500, y: 30 } })]}
        currentView={mapView}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on non-map frames (an entered scene keeps its pixels)", () => {
    const { container } = render(
      <MapLabelOverlay
        nodeId="n1"
        entities={[entity()]}
        geoEntities={[geo()]}
        currentView={{ ...mapView, level: "eye" }}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("a null view is treated as a map (the classic top frame)", () => {
    render(
      <MapLabelOverlay
        nodeId="n1"
        entities={[entity()]}
        geoEntities={[]}
        currentView={null}
      />,
    );
    expect(screen.getByText("Harbour")).toBeTruthy();
  });

  it("skips entities without a bbox on THIS node or without a name", () => {
    const { container } = render(
      <MapLabelOverlay
        nodeId="other-node"
        entities={[entity(), entity({ id: "e2", name: "   " })]}
        geoEntities={[]}
        currentView={mapView}
      />,
    );
    // e1's bbox is keyed to n1, not other-node; e2 has no usable name; no geo
    // fallback data → nothing renders at all.
    expect(container.innerHTML).toBe("");
  });
});
