import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SpatialTransitionLayer } from "./SpatialTransitionLayer";
import { planSpatialTransition, type ReframePlan } from "@/lib/spatial-transition";
import { spatialAssetPath, SPATIAL_STUDY_CASES } from "@/lib/spatial-study";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("uses the contained rectangle, clips pixels and remeasures on resize", () => {
  let measure!: () => void;
  vi.stubGlobal("ResizeObserver", class { constructor(fn: () => void) { measure = fn; } observe() {} disconnect() {} });
  const w = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  const plan = planSpatialTransition({ id: "p", parentId: null, image: "source.jpg" }, { id: "c", parentId: "p", image: "dest.jpg", click: { x_pct: .8, y_pct: .2 } }) as ReframePlan;
  const { rerender } = render(<SpatialTransitionLayer motion={null} />);
  expect(screen.queryByTestId("spatial-transition")).toBeNull();
  rerender(<SpatialTransitionLayer motion={{ plan, progress: .5, width: 1600, height: 900 }} />);
  const content = screen.getByTestId("spatial-content");
  expect(content.style.top).toBe("75px"); expect(content.style.height).toBe("450px");
  expect(content.style.overflow).toBe("hidden");
  expect(content.querySelector("img")!.style.transform).toContain("matrix(1.175, 0, 0, 1.175");
  w.mockReturnValue(400); act(() => measure());
  expect(content.style.top).toBe("187.5px"); expect(content.style.width).toBe("400px");
});
it("allows only the six frozen images and six saved video names", () => {
  for (const c of SPATIAL_STUDY_CASES) for (const file of [c.source, `${c.id}-destination.jpg`, c.h3, c.ltx]) expect(spatialAssetPath(file)).not.toBeNull();
  for (const file of ["../.env", "/etc/passwd", "review.html", "unknown.mp4"]) expect(spatialAssetPath(file)).toBeNull();
});
