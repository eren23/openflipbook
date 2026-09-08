import { describe, expect, it } from "vitest";

import { objectContainRect } from "./image-click";
import { bindTransitionContext } from "./transition-context";
import { planSpatialTransition, reframeMatrix, sampleReframe, type ReframePlan, type SpatialFrame } from "./spatial-transition";

const parent: SpatialFrame = { id: "p", parentId: null, image: "map.jpg", imageKey: "original", view: { node_id: "p", level: "map", observer: null, map_crop: null } };
const child: SpatialFrame = { id: "c", parentId: "p", image: "scene.jpg", click: { x_pct: .9, y_pct: .1 }, relation: "descend" };

describe("spatial transition planner", () => {
  it("uses frozen evidence, not a later click or view", () => {
    const context = bindTransitionContext(null, { id: "p", image_key: "original", scene_view: parent.view! }, child.click, null)!;
    const plan = planSpatialTransition({ ...parent, view: null }, { ...child, click: { x_pct: .2, y_pct: .2 }, context });
    expect(plan).toMatchObject({ kind: "forward", target: child.click, fraction: .42, duration: 800, hold: 100 });
    expect(planSpatialTransition({ ...parent, imageKey: "revision" }, { ...child, context }).kind).toBe("cut");
    expect(planSpatialTransition({ ...parent, imageKey: undefined }, { ...child, context }).kind).toBe("cut");
    expect(planSpatialTransition(parent, { ...child, context: { ...context, source_node_id: "other" } }).kind).toBe("cut");
  });
  it("reverses the same parent plan for direct back", () => {
    const forward = planSpatialTransition(parent, child) as ReframePlan;
    expect(planSpatialTransition(child, parent)).toEqual({ ...forward, kind: "back" });
  });
  it("caps scenes and unknown views at 1.35x", () => {
    for (const view of [null, { ...parent.view!, level: "eye" as const }]) {
      const plan = planSpatialTransition({ ...parent, view }, child) as ReframePlan;
      expect(plan.duration).toBe(450);
      expect(sampleReframe(plan, 1).scale).toBeCloseTo(1.35);
    }
  });
  it("cuts unrelated, edited, outward, unknown and reduced-motion edges", () => {
    expect(planSpatialTransition(parent, child, true)).toEqual({ kind: "cut", reason: "reduced-motion" });
    expect(planSpatialTransition(parent, { ...child, parentId: "other" }).kind).toBe("cut");
    expect(planSpatialTransition(parent, { ...child, click: null }).kind).toBe("cut");
    expect(planSpatialTransition(parent, { ...child, click: { x_pct: NaN, y_pct: .5 } }).kind).toBe("cut");
    for (const relation of ["edit", "expand", "ascend"]) expect(planSpatialTransition(parent, { ...child, relation }).kind).toBe("cut");
  });
  it("keeps targets visible, moves them monotonically toward center, and exposes no borders", () => {
    for (const map of [true, false]) for (let x = 0; x <= 100; x++) for (let y = 0; y <= 100; y++) {
      const point = { x_pct: x / 100, y_pct: y / 100 };
      const plan = planSpatialTransition({ ...parent, view: map ? parent.view : null }, { ...child, click: point }) as ReframePlan;
      let lastDistance = Infinity;
      for (let step = 0; step <= 20; step++) {
        const m = sampleReframe(plan, step / 20);
        const qx = m.scale * point.x_pct + m.x;
        const qy = m.scale * point.y_pct + m.y;
        const distance = Math.hypot(qx - .5, qy - .5);
        // Throw once, with coordinates, rather than millions of matcher allocations.
        if (qx < -1e-9 || qx > 1 + 1e-9 || qy < -1e-9 || qy > 1 + 1e-9 || distance > lastDistance + 1e-9 ||
            m.x > 1e-9 || m.y > 1e-9 || m.x + m.scale < 1 - 1e-9 || m.y + m.scale < 1 - 1e-9) throw new Error(`Geometry failure: ${map}, ${x}, ${y}, ${step}`);
        lastDistance = distance;
      }
    }
  });
  it.each([[1200, 700, 900, 1600], [390, 700, 1600, 900], [800, 800, 800, 800]])("maps the transform into contain content for %j", (w, h, nw, nh) => {
    const rect = objectContainRect(w, h, nw, nh)!;
    const plan = planSpatialTransition(parent, child) as ReframePlan;
    const m = sampleReframe(plan, 1);
    expect(reframeMatrix(plan, 1, rect.width, rect.height)).toBe(`matrix(${m.scale}, 0, 0, ${m.scale}, ${m.x * rect.width}, ${m.y * rect.height})`);
    expect(rect.width / rect.height).toBeCloseTo(nw / nh);
    expect(sampleReframe(plan, -1)).toEqual({ scale: 1, x: -0, y: -0 });
    expect(sampleReframe(plan, 2)).toEqual(m);
  });
});
