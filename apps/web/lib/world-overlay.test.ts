import { describe, expect, it } from "vitest";

import type { MapCrop, ObserverPose } from "@openflipbook/config";

import { gazeConePoints, viewToWorld, worldToView } from "./world-overlay";

const CROP: MapCrop = { x: 0, y: 0, w: 100, h: 100 };
const VIEW = { w: 200, h: 200 };

describe("world-overlay top-down projection", () => {
  it("worldToView scales + offsets a world point into the viewport", () => {
    expect(worldToView({ x: 0, y: 0 }, CROP, VIEW)).toEqual({ x: 0, y: 0 });
    expect(worldToView({ x: 50, y: 50 }, CROP, VIEW)).toEqual({ x: 100, y: 100 });
    expect(worldToView({ x: 100, y: 100 }, CROP, VIEW)).toEqual({ x: 200, y: 200 });
  });

  it("honours padding (uniform scale picks the tighter axis)", () => {
    const v = { w: 220, h: 220, pad: 10 };
    // usable 200×200 over a 100×100 crop → scale 2, origin (10,10)
    expect(worldToView({ x: 0, y: 0 }, CROP, v)).toEqual({ x: 10, y: 10 });
    expect(worldToView({ x: 100, y: 100 }, CROP, v)).toEqual({ x: 210, y: 210 });
  });

  it("viewToWorld is the inverse of worldToView", () => {
    const p = { x: 37, y: 81 };
    const screen = worldToView(p, CROP, VIEW);
    const back = viewToWorld(screen, CROP, VIEW);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it("gazeConePoints opens fov around gaze (world bearing == screen angle)", () => {
    const obs: ObserverPose = {
      pos: { x: 50, y: 50 },
      eye_height: 1.7,
      gaze: 0, // +x / east → screen right
      fov: Math.PI / 2,
    };
    const c = gazeConePoints(obs, CROP, VIEW, 50);
    expect(c.apex).toEqual({ x: 100, y: 100 });
    expect(c.center.x).toBeCloseTo(150, 6); // straight right
    expect(c.center.y).toBeCloseTo(100, 6);
    // ±45° edges
    expect(c.left.x).toBeCloseTo(100 + 50 * Math.cos(-Math.PI / 4), 6);
    expect(c.left.y).toBeCloseTo(100 + 50 * Math.sin(-Math.PI / 4), 6);
    expect(c.right.x).toBeCloseTo(100 + 50 * Math.cos(Math.PI / 4), 6);
    expect(c.right.y).toBeCloseTo(100 + 50 * Math.sin(Math.PI / 4), 6);
  });
});
