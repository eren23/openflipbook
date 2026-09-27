import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { insertCameraKeyframe, orbitPose, orbitPosition, sampleCameraPath } from "./camera-path";

describe("world-space orbit path", () => {
  it("anchors direction, height and metre distance to the supplied pivot", () => {
    const pivot = new Vector3(12, 4, -8);
    expect(orbitPosition(pivot, { azimuth: 0, elevation: 0, distance: 10 }).toArray()).toEqual([12, 4.000000000000001, 2]);
    const right = orbitPosition(pivot, { azimuth: 90, elevation: 0, distance: 10 });
    expect(right.x).toBeCloseTo(22); expect(right.z).toBeCloseTo(-8);
    const raised = orbitPosition(pivot, { azimuth: -45, elevation: 30, distance: 20 });
    expect(raised.y).toBeCloseTo(14); expect(raised.distanceTo(pivot)).toBeCloseTo(20);
    const pose = orbitPose(raised, pivot);
    expect(pose.azimuth).toBeCloseTo(-45); expect(pose.elevation).toBeCloseTo(30); expect(pose.distance).toBeCloseTo(20);
  });
  it("interpolates signed full turns without shortest-arc reversal", () => {
    const frames = [{ time: 0, azimuth: -180, elevation: 10, distance: 4 }, { time: 1, azimuth: 540, elevation: 50, distance: 12 }];
    expect(sampleCameraPath(frames, 0.5)).toMatchObject({ azimuth: 180, elevation: 30, distance: 8 });
    expect(sampleCameraPath(frames, -1)).toMatchObject(frames[0]!);
    expect(sampleCameraPath(frames, 2)).toMatchObject(frames[1]!);
    expect(() => sampleCameraPath([], 0)).toThrow();
    expect(() => sampleCameraPath(frames, NaN)).toThrow();
  });
  it("inserts the interpolated pose in time order and bounds keyframe density", () => {
    const frames = [{ time: 0, azimuth: 0, elevation: 10, distance: 4 }, { time: 1, azimuth: 180, elevation: 30, distance: 8 }];
    const inserted = insertCameraKeyframe(frames, 0.5);
    expect(inserted[1]).toEqual({ time: 0.5, azimuth: 90, elevation: 20, distance: 6 });
    for (const time of [0, 1, -1, 2, NaN, 0.501]) expect(insertCameraKeyframe(inserted, time)).toEqual(inserted);
    const full = Array.from({ length: 12 }, (_, i) => ({ ...frames[0]!, time: i / 11 }));
    expect(insertCameraKeyframe(full, 0.5)).toEqual(full);
    expect(frames).toHaveLength(2);
  });
});
