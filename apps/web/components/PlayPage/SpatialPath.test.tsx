import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SpatialPath from "./SpatialPath";

describe("SpatialPath", () => {
  it("stacks the ancestry (current foremost); clicking an ancestor zooms out", () => {
    const onNavigate = vi.fn();
    render(
      <SpatialPath
        crumbs={[
          { nodeId: "root", title: "Ankh-Morpork" },
          { nodeId: "mid", title: "Unseen University" },
          { nodeId: "cur", title: "Tower of Art" },
        ]}
        onNavigate={onNavigate}
      />,
    );
    const cards = screen.getAllByTestId("spatial-card");
    expect(cards).toHaveLength(3);
    // the current scene is the foremost, non-navigable card
    expect(cards[2]!.getAttribute("aria-current")).toBe("page");
    expect((cards[2] as HTMLButtonElement).disabled).toBe(true);
    // clicking an ancestor zooms out to it
    fireEvent.click(cards[0]!);
    expect(onNavigate).toHaveBeenCalledWith("root");
  });

  it("a single crumb has nothing to zoom out to → renders nothing", () => {
    const { container } = render(
      <SpatialPath
        crumbs={[{ nodeId: "root", title: "Ankh-Morpork" }]}
        onNavigate={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
