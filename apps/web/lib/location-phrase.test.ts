import { describe, expect, it } from "vitest";

import { locationPhrase } from "./location-phrase";

const FRAME = { x: 0, y: 0, w: 100, h: 60 };
const geo = (x: number, y: number, w = 6, d = 6) => ({
  pos: { x, y },
  footprint: { w, d },
});

describe("locationPhrase", () => {
  it("maps the 3×3 compass grid (+y = south)", () => {
    expect(locationPhrase(geo(10, 5), FRAME)).toBe("the north-west of the map");
    expect(locationPhrase(geo(50, 5), FRAME)).toBe("the north of the map");
    expect(locationPhrase(geo(90, 55), FRAME)).toBe(
      "the south-east of the map",
    );
    expect(locationPhrase(geo(50, 30), FRAME)).toBe("the center of the map");
    expect(locationPhrase(geo(90, 30), FRAME)).toBe("the east of the map");
  });

  it("calls out edge-spanning entities (the river case)", () => {
    expect(locationPhrase(geo(50, 30, 95, 8), FRAME)).toBe(
      "spanning the map east–west across its middle",
    );
    expect(locationPhrase(geo(50, 8, 95, 8), FRAME)).toBe(
      "spanning the map east–west across its north",
    );
    expect(locationPhrase(geo(20, 30, 8, 58), FRAME)).toBe(
      "spanning the map north–south through its west",
    );
    expect(locationPhrase(geo(50, 30, 80, 50), FRAME)).toBe(
      "spanning the whole map",
    );
  });

  it("makes no claim for out-of-frame or degenerate inputs", () => {
    expect(locationPhrase(geo(140, 30), FRAME)).toBeNull();
    expect(locationPhrase(geo(50, -20), FRAME)).toBeNull();
    expect(locationPhrase(geo(50, 30), { x: 0, y: 0, w: 0, h: 0 })).toBeNull();
    expect(locationPhrase(geo(Number.NaN, 30), FRAME)).toBeNull();
  });
});
