import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import SessionMinimap from "./session-minimap";
import type { LayoutInput } from "@/lib/world-layout";

function page(partial: Partial<LayoutInput> & { nodeId: string }): LayoutInput {
  return {
    parentId: null,
    imageDataUrl: null,
    title: partial.nodeId,
    ...partial,
  };
}

describe("SessionMinimap relation tint", () => {
  it("tints expand tiles teal so breadth reads apart from tap-in ink", () => {
    const { container } = render(
      <SessionMinimap
        pages={[
          page({ nodeId: "root" }),
          page({ nodeId: "down", parentId: "root", relation: "descend" }),
          page({ nodeId: "out", parentId: "root", relation: "expand" }),
        ]}
        activeNodeId="root"
        onExpand={() => {}}
        onJump={() => {}}
      />,
    );
    const tile = (title: string) =>
      container.querySelector<HTMLElement>(`button[title="${title}"]`);
    // Expand tile: the atlas/world-map teal (13,148,136).
    expect(tile("out")!.getAttribute("data-relation")).toBe("expand");
    expect(tile("out")!.style.background).toMatch(/13,\s*148,\s*136/);
    // Descend tile keeps the ink fill.
    expect(tile("down")!.style.background).toMatch(/15,\s*15,\s*15/);
  });

  it("active tile stays red even when it is an expand page", () => {
    const { container } = render(
      <SessionMinimap
        pages={[
          page({ nodeId: "root" }),
          page({ nodeId: "out", parentId: "root", relation: "expand" }),
        ]}
        activeNodeId="out"
        onExpand={() => {}}
        onJump={() => {}}
      />,
    );
    const active = container.querySelector<HTMLElement>(
      '[data-relation="expand"]',
    );
    expect(active!.style.background).toMatch(/239,\s*68,\s*68/);
  });
});
