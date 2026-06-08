import { describe, expect, it } from "vitest";

import type { SceneView } from "@openflipbook/config";

import { type NodeDoc, toRow } from "./db";

function doc(overrides: Partial<NodeDoc> = {}): NodeDoc {
  return {
    _id: "n1",
    parent_id: null,
    session_id: "s1",
    query: "q",
    page_title: "t",
    image_key: "k",
    image_model: "m",
    prompt_author_model: "pm",
    aspect_ratio: "16:9",
    final_prompt: null,
    click_in_parent: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as NodeDoc;
}

const sceneView: SceneView = {
  node_id: "n1",
  level: "building",
  observer: {
    pos: { x: 10, y: 5 },
    eye_height: 1.7,
    gaze: 0.5,
    fov: Math.PI / 2,
    pitch: 0.1,
  },
  map_crop: null,
  focus_id: "geo_tower",
};

describe("toRow scene_view round-trip", () => {
  it("preserves a persisted scene_view (the observer survives the read path)", () => {
    const row = toRow(doc({ scene_view: sceneView }));
    expect(row.scene_view).toEqual(sceneView);
    // the angle is what the minimap + re-entry restore depends on
    expect(row.scene_view?.observer?.pitch).toBe(0.1);
  });

  it("defaults a missing scene_view to null (back-compat with pre-geometry rows)", () => {
    const row = toRow(doc());
    expect(row.scene_view).toBeNull();
  });
});
