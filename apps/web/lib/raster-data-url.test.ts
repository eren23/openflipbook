import { expect, it } from "vitest";
import { MAX_SKETCH_BYTES, rasterDataUrl } from "./sketch-types";

it("validates detailed multi-megabyte exports without regexp stack exhaustion", () => {
  const payload = "A".repeat(8 * 1024 * 1024);
  expect(rasterDataUrl(`data:image/png;base64,${payload}==`)).toBe(true);
  expect(rasterDataUrl(`data:image/png;base64,${payload}!`)).toBe(false);
});
it("retains supported raster headers and trailing-only base64 padding", () => {
  for (const type of ["png", "jpeg", "webp"]) expect(rasterDataUrl(`data:image/${type};base64,YQ==`)).toBe(true);
  for (const value of [null, "", "data:image/svg+xml;base64,YQ==", "data:image/png;base64,", "data:image/png;base64,==", "data:image/png;base64,Y=Q=", "data:image/png;base64,YQ===", "data:image/png;base64,YQ==\n", `data:image/png;base64,${"A".repeat(Math.ceil(MAX_SKETCH_BYTES * 1.4))}`]) expect(rasterDataUrl(value)).toBe(false);
});
