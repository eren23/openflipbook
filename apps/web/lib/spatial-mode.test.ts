import { expect, it } from "vitest";
import { spatialPage, spatialNode } from "./spatial-mode";

it("maps live and wire pages onto the same planner inputs", () => {
  const page = { nodeId: "c", parentId: "p", sessionId: "s", query: "q", title: "T", imageDataUrl: "img", imageKey: "key", clickInParent: { xPct: .2, yPct: .8 }, relation: "descend" as const };
  const wire = { id: "c", parent_id: "p", image_url: "img", image_key: "key", page_title: "T", created_at: "1", click_in_parent: { x_pct: .2, y_pct: .8 }, relation: "descend" as const };
  expect(spatialPage(page)).toEqual(spatialNode(wire));
  expect(spatialPage(null)).toMatchObject({ id: null, parentId: null, image: "", click: null });
});
