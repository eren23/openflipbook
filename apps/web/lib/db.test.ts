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

it("derives durable playback from the current node ID while preserving historical provider URLs", () => {
  const external = "https://fal.media/arrival.mp4";
  expect(toRow(doc({ descent_video_url: external })).descent_video_url).toBe(external);
  const stored = { version: 1 as const, key: "source/descent-videos/source-child/abc.mp4", sha256: "a".repeat(64), bytes: 40, content_type: "video/mp4" as const, parent_node_id: "source-parent", parent_image_key: "source-parent.png", node_image_key: "child.png" };
  const row = toRow(doc({ _id: "fork-child", session_id: "fork", descent_video_url: external, descent_video: stored }));
  expect(row.descent_video_url).toBe("/api/nodes/fork-child/descent-video");
  expect(row.descent_video).toEqual(stored);
});

describe("toRow scale_tier round-trip (B2)", () => {
  it("preserves a persisted scale_tier and an ascend relation", () => {
    const row = toRow(doc({ scale_tier: "city", relation: "ascend" }));
    expect(row.scale_tier).toBe("city");
    expect(row.relation).toBe("ascend");
  });

  it("defaults a missing scale_tier to null (back-compat with pre-B2 rows)", () => {
    const row = toRow(doc());
    expect(row.scale_tier).toBeNull();
  });
});

describe("toRow view_verdict + forked_from round-trip", () => {
  it("preserves a persisted render receipt and fork lineage", () => {
    const verdict = {
      same_place: 9.0,
      conformance: null,
      medium: 10.0,
      detail: null,
      interior: null,
      attempts: 2,
      accepted: false,
    };
    const lineage = { session_id: "session_src", node_id: "n0" };
    const row = toRow(doc({ view_verdict: verdict, forked_from: lineage }));
    expect(row.view_verdict).toEqual(verdict);
    expect(row.forked_from).toEqual(lineage);
  });

  it("defaults both to null on legacy rows (every pre-receipts document)", () => {
    const row = toRow(doc());
    expect(row.view_verdict).toBeNull();
    expect(row.forked_from).toBeNull();
  });
});
