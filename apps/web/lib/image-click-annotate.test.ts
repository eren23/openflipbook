import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { annotateClickPoint, annotateStroke } from "./image-click";
import type { NormalizedStroke } from "./image-click";

/**
 * happy-dom does not implement Path2D and its canvas getContext returns a
 * stripped-down 2D context. We polyfill Path2D + a spy-friendly 2D context
 * per test so the annotate functions can run end-to-end.
 */
type Call = [string, unknown[]];

class FakePath2D {
  calls: Call[] = [];
  moveTo(x: number, y: number): void {
    this.calls.push(["moveTo", [x, y]]);
  }
  lineTo(x: number, y: number): void {
    this.calls.push(["lineTo", [x, y]]);
  }
}

interface MockCtx {
  drawImage: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  lineWidth: number;
  strokeStyle: string;
  fillStyle: string;
  lineCap: string;
  lineJoin: string;
}

function makeCtx(): MockCtx {
  return {
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    lineCap: "",
    lineJoin: "",
  };
}

const ORIGINAL_DATA_URL = "data:image/png;base64,ORIGINAL";
const STUBBED_OUTPUT = "data:image/jpeg;base64,FAKE";

let path2dRestore: (() => void) | null = null;

function installPath2D(): FakePath2D[] {
  const created: FakePath2D[] = [];
  const Wrapped = function (this: FakePath2D) {
    const inst = new FakePath2D();
    created.push(inst);
    return inst;
  } as unknown as typeof Path2D;
  const had = "Path2D" in globalThis;
  const prev = (globalThis as { Path2D?: unknown }).Path2D;
  (globalThis as { Path2D?: unknown }).Path2D = Wrapped;
  path2dRestore = () => {
    if (had) (globalThis as { Path2D?: unknown }).Path2D = prev;
    else delete (globalThis as { Path2D?: unknown }).Path2D;
  };
  return created;
}

beforeEach(() => {
  // Each test sets its own naturalWidth / naturalHeight via Image.prototype.
  vi.spyOn(Image.prototype, "decode").mockResolvedValue(undefined);
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get: () => 1000,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
    configurable: true,
    get: () => 500,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(STUBBED_OUTPUT);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (path2dRestore) {
    path2dRestore();
    path2dRestore = null;
  }
});

describe("annotateClickPoint", () => {
  it("returns the original dataUrl when canvas 2D context is unavailable", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await annotateClickPoint(ORIGINAL_DATA_URL, 0.5, 0.5);
    expect(out).toBe(ORIGINAL_DATA_URL);
    expect(warn).toHaveBeenCalled(); // degradation must be loud
  });

  it("paints crosshair primitives onto the canvas and returns the encoded data URL", async () => {
    const ctx = makeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );

    const out = await annotateClickPoint(ORIGINAL_DATA_URL, 0.25, 0.5);

    expect(out).toBe(STUBBED_OUTPUT);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);

    // Expect at least one arc call at (x, y, r, 0, 2π) with the computed coords.
    // canvas.width = naturalWidth = 1000, so x = 0.25 * 1000 = 250, y = 0.5 * 500 = 250.
    // r = max(24, round(1000 * 0.02)) = max(24, 20) = 24.
    const arcCalls = ctx.arc.mock.calls;
    expect(arcCalls.length).toBeGreaterThanOrEqual(2);
    const fullCircleAt250 = arcCalls.some(
      (c) =>
        c[0] === 250 &&
        c[1] === 250 &&
        c[2] === 24 &&
        c[3] === 0 &&
        c[4] === Math.PI * 2
    );
    expect(fullCircleAt250).toBe(true);

    // Centre dot fill should have been issued.
    expect(ctx.fill).toHaveBeenCalled();
  });
});

describe("annotateStroke", () => {
  const tinyStroke: NormalizedStroke = {
    points: [{ x_pct: 0.1, y_pct: 0.1 }],
    bbox: { x: 0.1, y: 0.1, w: 0, h: 0 },
    centroid: { x_pct: 0.1, y_pct: 0.1 },
  };

  const realStroke: NormalizedStroke = {
    points: [
      { x_pct: 0.1, y_pct: 0.2 },
      { x_pct: 0.3, y_pct: 0.4 },
      { x_pct: 0.5, y_pct: 0.6 },
    ],
    bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 },
    centroid: { x_pct: 0.3, y_pct: 0.4 },
  };

  it("returns the original dataUrl when the stroke has fewer than 2 points", async () => {
    const out = await annotateStroke(ORIGINAL_DATA_URL, tinyStroke);
    expect(out).toBe(ORIGINAL_DATA_URL);
  });

  it("returns the original dataUrl when canvas 2D context is unavailable", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await annotateStroke(ORIGINAL_DATA_URL, realStroke);
    expect(out).toBe(ORIGINAL_DATA_URL);
    expect(warn).toHaveBeenCalled(); // degradation must be loud
  });

  it("draws moveTo + lineTo for each stroke point and returns the encoded data URL", async () => {
    const paths = installPath2D();
    const ctx = makeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );

    const out = await annotateStroke(ORIGINAL_DATA_URL, realStroke);
    expect(out).toBe(STUBBED_OUTPUT);

    // One Path2D was constructed for the polyline.
    expect(paths.length).toBe(1);
    const path = paths[0]!;
    // First point uses moveTo, remaining two use lineTo.
    // canvas.width = 1000, height = 500.
    expect(path.calls[0]).toEqual(["moveTo", [100, 100]]); // 0.1 * 1000, 0.2 * 500
    expect(path.calls[1]).toEqual(["lineTo", [300, 200]]); // 0.3 * 1000, 0.4 * 500
    expect(path.calls[2]).toEqual(["lineTo", [500, 300]]); // 0.5 * 1000, 0.6 * 500

    // Background image stamped, and stroke was issued at least for the polyline
    // (white halo + red overlay) plus the centroid crosshair circles.
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.arc).toHaveBeenCalled();
  });
});
