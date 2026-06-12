import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Crumb } from "@/lib/breadcrumb";

import Breadcrumb from "./Breadcrumb";

const crumb = (n: number): Crumb => ({ nodeId: `n${n}`, title: `Step ${n}` });
const trail = (len: number): Crumb[] =>
  Array.from({ length: len }, (_, i) => crumb(i + 1));

describe("Breadcrumb (deep-trail collapse, A4)", () => {
  it("short trails render every crumb, no ellipsis", () => {
    render(<Breadcrumb crumbs={trail(4)} onJump={() => {}} />);
    for (let i = 1; i <= 4; i++) {
      expect(screen.getByText(`Step ${i}`)).toBeTruthy();
    }
    expect(screen.queryByText("…")).toBeNull();
  });

  it("deep trails collapse to root › … › last two", () => {
    render(<Breadcrumb crumbs={trail(7)} onJump={() => {}} />);
    expect(screen.getByText("Step 1")).toBeTruthy(); // root stays jumpable
    expect(screen.getByText("Step 6")).toBeTruthy();
    expect(screen.getByText("Step 7")).toBeTruthy();
    expect(screen.queryByText("Step 3")).toBeNull(); // middle hidden
    expect(screen.getByText("…")).toBeTruthy();
  });

  it("the ellipsis expands the full trail; ancestors still jump", () => {
    const onJump = vi.fn();
    render(<Breadcrumb crumbs={trail(7)} onJump={onJump} />);
    fireEvent.click(screen.getByText("…"));
    expect(screen.getByText("Step 3")).toBeTruthy();
    fireEvent.click(screen.getByText("Step 3"));
    expect(onJump).toHaveBeenCalledWith("n3");
  });

  it("a single crumb renders nothing (you haven't gone in yet)", () => {
    const { container } = render(
      <Breadcrumb crumbs={trail(1)} onJump={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
