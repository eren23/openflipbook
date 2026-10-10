import { expect, it } from "vitest";
import { imageLedRouteIntent } from "./image-led-route-intent";

const source = { width: 2048, height: 1152, sha256: "a".repeat(64) };
const route = [[940, 900], [1020, 815], [1060, 720], [1070, 630], [1050, 545], [1030, 465]].map(([x, y]) => ({ x: x! / source.width, y: y! / source.height }));
const landmark = (id: string, x: number, y: number) => ({ id, label: id, source_rectangle: { left: x - 16, top: y - 16, width: 32, height: 32 } });
const intent = (points = route, landmarks = [landmark("fountain", 1000, 250), landmark("well", 1310, 750)]) => imageLedRouteIntent({ source, points, landmarks, checkpointIndex: 0 });

it("represents the route's real image-plane bend rather than an always-centred fountain", () => {
  const value = intent();
  expect(value.checkpoints.map(c => c.heading_degrees)).toEqual([43.264295, 22.833654, 6.340192, 346.75948, 345.963757, 345.963757]);
  expect(value.checkpoints.map(c => c.turn)).toEqual(["start", "left", "left", "left", "continue", "end"]);
  expect(value.checkpoints[0]!.landmark_relations).toMatchObject([{ id: "fountain", sector: "ahead_left" }, { id: "well", sector: "ahead_right" }]);
  expect(value.checkpoints[5]!.landmark_relations[0]!.sector).not.toBe("at_checkpoint");
  expect(value).toMatchObject({ basis: "source-image-pixels", registration: "estimated", source_sha256: source.sha256 });
  expect(value).not.toHaveProperty("camera_yaw"); expect(value).not.toHaveProperty("field_of_view");
});

it("accounts for original image aspect ratio rather than treating normalized coordinates as a square map", () => {
  const value = intent([{ x: .1, y: .9 }, { x: .5, y: .5 }], []);
  expect(value.checkpoints[0]!.heading_degrees).toBeCloseTo(Math.atan2(2048, 1152) * 180 / Math.PI, 5);
  expect(value.checkpoints[0]!.heading_degrees).not.toBe(45);
});

it("wraps turns across north correctly and keeps final heading without inventing an arrival or a last turn", () => {
  const value = intent([{ x: .5, y: .9 }, { x: .49, y: .6 }, { x: .5, y: .3 }], []);
  expect(value.checkpoints[0]!.heading_degrees).toBeGreaterThan(350);
  expect(value.checkpoints[1]!.turn_from_previous_degrees).toBeGreaterThan(0);
  expect(value.checkpoints[1]!.turn_from_previous_degrees).toBeLessThan(10);
  expect(value.checkpoints[2]!.heading_degrees).toBe(value.checkpoints[1]!.heading_degrees);
  expect(value.checkpoints[2]!.turn).toBe("end");
});

it("keeps all surrounding source anchors, including behind-camera context, without claiming visibility", () => {
  const value = intent([{ x: .5, y: .7 }, { x: .5, y: .4 }], [landmark("ahead", 1024, 400), landmark("harbour", 1024, 1000), landmark("here", 1024, 806)]);
  expect(value.checkpoints[0]!.landmark_relations.map(l => l.sector)).toEqual(["ahead", "behind", "ahead"]);
  const exact = intent([{ x: 1024 / 2048, y: 806 / 1152 }, { x: .5, y: .4 }], [landmark("here", 1024, 806)]);
  expect(exact.checkpoints[0]!.landmark_relations[0]!.sector).toBe("at_checkpoint");
  expect(value.checkpoints[0]!.landmark_relations[1]).not.toHaveProperty("visible");
});

it.each(["duplicate", "outside", "wrongIndex", "outsideCrop"])("rejects %s source intent rather than inventing a camera", kind => {
  const input = { source, points: route, landmarks: [landmark("well", 1310, 750)], checkpointIndex: 0 };
  if (kind === "duplicate") input.points = [route[0]!, route[0]!];
  if (kind === "outside") input.points = [{ x: -1, y: .5 }, route[1]!];
  if (kind === "wrongIndex") input.checkpointIndex = 6;
  if (kind === "outsideCrop") input.landmarks = [landmark("outside", 2048, 750)];
  expect(() => imageLedRouteIntent(input)).toThrow(RangeError);
});
