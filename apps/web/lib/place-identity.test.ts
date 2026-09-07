import { describe, expect, it } from "vitest";
import type { SceneView, ViewVerdict, WorldEntityGeo } from "@openflipbook/config";
import { isVerifiedView, parsePlaceUpdate, preservePlaceIdentity, validReferenceBox } from "./place-identity";
import { findRevisitTarget } from "./world-mode";
import { placeCandidates } from "./place-selection";

const box = { x_pct: .1, y_pct: .2, w_pct: .3, h_pct: .4 };
const version = "2026-09-06T00:00:00.000Z";
const geo = (id: string, x = 50): WorldEntityGeo => ({ id, entity_id: null, kind: "place", label: id, pos: { x, y: 30 }, footprint: { w: 10, d: 10 }, height: 4, visual: "stone tower", state: {}, confidence: 1, source: "user", updated_at: version });
const view = (id: string, closeup = false): SceneView => ({ node_id: "saved", level: closeup ? "map" : "building", observer: null, map_crop: null, focus_id: id, closeup });

describe("place identity validation", () => {
  it("accepts a bounded same-world reference request without accepting a storage key", () => {
    expect(parsePlaceUpdate({ expected_updated_at: version, reference: { node_id: "node1", bbox: box }, identity_locked: true })).not.toBeNull();
    expect(parsePlaceUpdate({ expected_updated_at: version, reference: { node_id: "node1", image_key: "another/world", bbox: box } })).toBeNull();
  });
  it.each([null, [], {}, { expected_updated_at: "yesterday" }, { expected_updated_at: version, label: " " }, { expected_updated_at: version, identity_locked: "yes" }, { expected_updated_at: version, visual: "x".repeat(2001) }, { expected_updated_at: version, pos: { x: 1, y: 2 } }, { expected_updated_at: version, reference: 2 }])("rejects malformed updates %#", value => expect(parsePlaceUpdate(value)).toBeNull());
  it.each([NaN, Infinity, -.1, 1.1])("rejects invalid crop coordinates %s", x_pct => expect(validReferenceBox({ ...box, x_pct })).toBe(false));
  it("rejects zero-sized and overflowing crops", () => {
    expect(validReferenceBox({ ...box, w_pct: 0 })).toBe(false);
    expect(validReferenceBox({ ...box, h_pct: .9 })).toBe(false);
  });
  it("keeps curated identity across extraction but allows geometric updates", () => {
    const previous = { ...geo("tower"), identity_locked: true, identity_anchor: { node_id: "n1", image_key: "old.png", bbox: box } };
    const next = preservePlaceIdentity(previous, { ...geo("tower", 60), label: "invented", visual: "new" });
    expect(next.label).toBe("tower"); expect(next.visual).toBe("stone tower");
    expect(next.pos.x).toBe(60); expect(next.identity_anchor).toEqual(previous.identity_anchor);
  });
  it("does not treat missing or nonfinite critics as verified", () => {
    const receipt: ViewVerdict = { accepted: true, attempts: 1, same_place: 8, medium: 8, conformance: 8, detail: 8, interior: null };
    expect(isVerifiedView(receipt)).toBe(true);
    for (const value of [null, NaN, Infinity, 11]) expect(isVerifiedView({ ...receipt, medium: value })).toBe(false);
    expect(isVerifiedView({ ...receipt, accepted: false })).toBe(false);
    expect(isVerifiedView({ ...receipt, same_place: null, interior: 8 }, { interior: true })).toBe(true);
    expect(isVerifiedView({ ...receipt, detail: null }, { outward: true })).toBe(true);
  });
});

describe("place-aware navigation", () => {
  it("reopens the same ID and view kind from a different parent", () => {
    const items = [{ nodeId: "close", parentId: "elsewhere", sceneView: view("tower", true) }, { nodeId: "inside", parentId: "elsewhere", sceneView: view("tower") }];
    expect(findRevisitTarget(items, "root", { x_pct: .9, y_pct: .9 }, .07, { geoId: "tower", kind: "scene" })).toBe("inside");
  });
  it("never substitutes a nearby known place", () => {
    const items = [{ nodeId: "wrong", parentId: "root", sceneView: view("other"), clickInParent: { xPct: .5, yPct: .5 } }];
    expect(findRevisitTarget(items, "root", { x_pct: .5, y_pct: .5 }, .07, { geoId: "tower", kind: "scene" })).toBeNull();
  });
  it("retains proximity fallback for genuinely legacy nodes", () => {
    expect(findRevisitTarget([{ nodeId: "old", parentId: "root", clickInParent: { xPct: .5, yPct: .5 } }], "root", { x_pct: .51, y_pct: .5 })).toBe("old");
  });
  it("returns both overlapping places, including imported roots without scene_view", () => {
    expect(placeCandidates([geo("a"), geo("b", 53)], [], "root", null, { x_pct: .52, y_pct: .5 }).map(e => e.id)).toEqual(["a", "b"]);
  });
  it("a child wins containment without hiding sibling ambiguity", () => {
    const parent = { ...geo("region"), footprint: { w: 100, d: 60 } };
    const child = { ...geo("tower"), parent_id: "region", pos: { x: 0, y: 0 } };
    expect(placeCandidates([parent, child], [], "root", null, { x_pct: .5, y_pct: .5 }).map(e => e.id)).toEqual(["tower"]);
  });
  it("does not treat world coordinates as perspective-image detections", () => {
    expect(placeCandidates([{ ...geo("child"), parent_id: "tower" }], [], "inside", view("tower"), { x_pct: .5, y_pct: .5 })).toEqual([]);
  });
});
