import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SceneView, WorldEntityGeo } from "@openflipbook/config";

import { EnterableMarkers } from "./EnterableMarkers";

function geo(
  id: string,
  x: number,
  y: number,
  opts: Partial<WorldEntityGeo> = {},
): WorldEntityGeo {
  return {
    id,
    entity_id: id,
    kind: "place",
    label: id,
    pos: { x, y },
    height: 4,
    footprint: { w: 8, d: 8 },
    visual: "",
    state: {},
    confidence: 1,
    source: "user",
    updated_at: "t",
    ...opts,
  };
}

function markerIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-entity-id]")).map(
    (el) => el.getAttribute("data-entity-id") ?? "",
  );
}

describe("EnterableMarkers (W3 idle enter affordance)", () => {
  it("rings top-level places on the map; items and nested children stay quiet", () => {
    const { container } = render(
      <EnterableMarkers
        entities={[
          geo("palace", 50, 30),
          geo("sword", 40, 20, { kind: "item" }),
          geo("hall", 60, 30, { parent_id: "palace" }),
        ]}
        currentView={null}
      />,
    );
    expect(markerIds(container)).toEqual(["palace"]);
  });

  it("inside an entered place (scene frame) → renders nothing", () => {
    const inside: SceneView = {
      node_id: "n1",
      level: "eye",
      observer: {
        pos: { x: 0, y: 0 },
        eye_height: 1.7,
        gaze: 0,
        pitch: 0,
        fov: 1.2,
      },
      map_crop: null,
    };
    const { container } = render(
      <EnterableMarkers entities={[geo("palace", 50, 30)]} currentView={inside} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("a submap frame scopes rings to its crop window", () => {
    const submap: SceneView = {
      node_id: "n1",
      level: "map",
      observer: null,
      map_crop: { x: 40, y: 20, w: 30, h: 20 },
    };
    const { container } = render(
      <EnterableMarkers
        entities={[geo("inside-crop", 50, 30), geo("outside-crop", 5, 5)]}
        currentView={submap}
      />,
    );
    expect(markerIds(container)).toEqual(["inside-crop"]);
  });

  it("markers never intercept pointer events (the tap must reach the image)", () => {
    const { container } = render(
      <EnterableMarkers entities={[geo("palace", 50, 30)]} currentView={null} />,
    );
    expect(
      (container.firstChild as HTMLElement).className.includes("pointer-events-none"),
    ).toBe(true);
  });
});
