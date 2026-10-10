// @vitest-environment node
import { expect, it } from "vitest";
import { imageLedEligible } from "./image-led-walk-server";
import { IMAGE_LED_MAP_FRAME, IMAGE_LED_WALK_PROFILE, type ImageLedStill, type ImageLedWalkDoc } from "./image-led-walk";

function route(): ImageLedWalkDoc {
  const file = { key: "original/map.png", sha256: "a".repeat(64), bytes: 256, width: 64, height: 64, content_type: "image/png" as const };
  return { _id: "world:walk", id: "walk", session_id: "world", profile: IMAGE_LED_WALK_PROFILE, created_at: new Date(0), updated_at: new Date(0), request_sha256: "b".repeat(64), status: "draft", revision: 1, prompt: "Preserve the book bay, moth sign and single open hearth",
    source: { node_id: "map", image_key: file.key, image: file, map_frame: { bounds: { x: 0, y: 0, w: 100, h: 100 }, parent_id: null }, source_projection: "illustrated_oblique_or_unknown", binding_sha256: "c".repeat(64) },
    landmarks: [], route: { frame: IMAGE_LED_MAP_FRAME, points: [{ x: .5, y: .9 }, { x: .5, y: .7 }, { x: .5, y: .5 }], map_sha256: file.sha256, sha256: "d".repeat(64) },
    frames: [0, 1, 2].map(index => ({ index, status: "empty", review: { identity: "pending", route: "pending", spatial: "unmeasured" } })),
    legs: [0, 1].map(index => ({ index, from: index, to: index + 1, status: "empty", review: { temporal: "pending" } })) };
}
function approve(walk: ImageLedWalkDoc, index: number): ImageLedStill {
  const image = { ...walk.source.image, key: `walk/frame-${index}.jpg`, content_type: "image/jpeg" as const, sha256: String(index + 1).repeat(64) };
  return walk.frames[index] = { index, status: "ready", raw: image, image, review: { identity: "approved", route: "approved", spatial: "unmeasured", sha256: image.sha256, reviewed_at: new Date(0).toISOString() } };
}

it("starts with an owned map route without requiring a saved 3D camera or mask proof", () => {
  const walk = route(); expect(() => imageLedEligible(walk, "still", 0)).not.toThrow();
  expect(walk).not.toHaveProperty("view_dependency"); expect(walk).not.toHaveProperty("scene_id");
});
it("does not treat a technically passed generic facade as reviewed source identity", () => {
  const walk = route(), frame = approve(walk, 0);
  frame.review.identity = "rejected"; frame.review.notes = "Proxy IoU 0.989; missing book bay, moth sign, hearth and glass crown";
  expect(() => imageLedEligible(walk, "still", 1)).toThrow("Review each preceding artwork");
});
it.each(["identity", "route", "bytes"])("blocks an adjacent view with missing or stale %s approval", kind => {
  const walk = route(), frame = approve(walk, 0);
  if (kind === "identity") frame.review.identity = "pending";
  if (kind === "route") frame.review.route = "rejected";
  if (kind === "bytes") frame.review.sha256 = "0".repeat(64);
  expect(() => imageLedEligible(walk, "still", 1)).toThrow();
});
it("cannot skip missing paintings or unresolved paid submissions", () => {
  const walk = route(); approve(walk, 0);
  expect(() => imageLedEligible(walk, "still", 2)).toThrow();
  walk.frames[1]!.status = "submission_unknown"; walk.frames[1]!.job_id = "retained-request";
  expect(() => imageLedEligible(walk, "still", 1)).toThrow("already has a request");
  expect(() => imageLedEligible(walk, "video", 0)).toThrow();
});
it("requires every reviewed still before making a clip, without turning unmeasured spatial review into calibration", () => {
  const walk = route(); approve(walk, 0); approve(walk, 1);
  expect(() => imageLedEligible(walk, "video", 0)).toThrow(); approve(walk, 2);
  expect(() => imageLedEligible(walk, "video", 0)).not.toThrow();
  expect(walk.frames.every(frame => frame.review.spatial === "unmeasured")).toBe(true);
});
it.each(["pending", "rejected", "stale"])("stops later clips after %s temporal continuity evidence", state => {
  const walk = route(); walk.frames.forEach((_, index) => approve(walk, index));
  const video = { key: "walk/leg-0.mp4", content_type: "video/mp4" as const, sha256: "e".repeat(64), bytes: 100 };
  walk.legs[0] = { index: 0, from: 0, to: 1, status: "ready", original: video, video,
    review: { temporal: state === "stale" ? "approved" : state as "pending" | "rejected", sha256: state === "stale" ? "f".repeat(64) : video.sha256, notes: "Bookshop door changes sides in intermediate frames" } };
  expect(() => imageLedEligible(walk, "video", 1)).toThrow("Review each earlier clip");
});
it("advances a clip only from exact accepted prior media and an empty next slot", () => {
  const walk = route(); walk.frames.forEach((_, index) => approve(walk, index));
  const video = { key: "walk/leg-0.mp4", content_type: "video/mp4" as const, sha256: "e".repeat(64), bytes: 100 };
  walk.legs[0] = { index: 0, from: 0, to: 1, status: "ready", original: video, video, review: { temporal: "approved", sha256: video.sha256 } };
  expect(() => imageLedEligible(walk, "video", 1)).not.toThrow();
  walk.legs[1]!.job_id = "already-claimed";
  expect(() => imageLedEligible(walk, "video", 1)).toThrow();
});
it.each(["archived", "provenance"])("keeps restored %s content ineligible for any paid operation", state => {
  const walk = route();
  if (state === "archived") walk.status = "archived";
  else walk.archive_provenance = { version: 1, source_session_id: "original-world", source_id: "walk", original_status: "active" };
  expect(() => imageLedEligible(walk, "still", 0)).toThrow("playback only");
  expect(() => imageLedEligible(walk, "video", 0)).toThrow("playback only");
});
