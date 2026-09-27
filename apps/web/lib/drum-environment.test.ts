import { expect, it } from "vitest";
import { DRUM_CAMERA, environmentCamera, projectEnvironmentPoint } from "./drum-environment";

it("uses a repeatable 16:9 camera with its authored target at image center", () => {
  const camera = environmentCamera();
  expect(camera.aspect).toBe(16 / 9);
  expect(camera.position.toArray()).toEqual(DRUM_CAMERA.position);
  const point = projectEnvironmentPoint(DRUM_CAMERA.target);
  expect(point.x).toBeCloseTo(0.5, 6);
  expect(point.y).toBeCloseTo(0.5, 6);
  expect(point.visible).toBe(true);
  expect(projectEnvironmentPoint([1000, 1000, 1000]).visible).toBe(false);
});
