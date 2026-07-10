import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import NeighbourTray, { type NeighbourItem } from "./NeighbourTray";

function item(over: Partial<NeighbourItem> = {}): NeighbourItem {
  return {
    key: over.key ?? "k1",
    subject: over.subject ?? "The Factory",
    scale: over.scale ?? "peer",
    imageDataUrl: over.imageDataUrl ?? "data:image/jpeg;base64,abc",
    nodeId: over.nodeId ?? "n1",
    ...over,
  };
}

const noop = () => {};

describe("NeighbourTray", () => {
  it("shows a proposing state before any neighbour arrives (not a blank bar)", () => {
    render(<NeighbourTray items={[]} total={0} done={false} onPick={noop} onClose={noop} />);
    expect(screen.getByRole("region")).toBeTruthy();
    expect(screen.getByText(/Looking around/)).toBeTruthy();
  });

  it("shows a 'no neighbours found' message + stays closeable when a bloom finishes empty", () => {
    const onClose = vi.fn();
    render(<NeighbourTray items={[]} total={0} done onPick={noop} onClose={onClose} />);
    expect(screen.getByText(/no neighbours found/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close neighbours" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders one card per neighbour with its subject + scale label", () => {
    render(
      <NeighbourTray
        items={[
          item({ key: "a", subject: "The Factory", scale: "container" }),
          item({ key: "b", subject: "Piston", scale: "peer" }),
          item({ key: "c", subject: "Valve", scale: "component" }),
        ]}
        total={3}
        done
        onPick={noop}
        onClose={noop}
      />
    );
    expect(screen.getByRole("button", { name: "Explore The Factory" })).toBeTruthy();
    // Scale encodes to a chip label: container→around, peer→beside, component→part.
    expect(screen.getByText("around")).toBeTruthy();
    expect(screen.getByText("beside")).toBeTruthy();
    expect(screen.getByText("part")).toBeTruthy();
  });

  it("shows an 'N of M' progress read while blooming, 'Around this page' when done", () => {
    const items = [item({ key: "a" }), item({ key: "b", imageDataUrl: null })];
    const { rerender } = render(
      <NeighbourTray items={items} total={4} done={false} onPick={noop} onClose={noop} />
    );
    // 1 of 2 have images → "1 of 4".
    expect(screen.getByText(/Looking around · 1 of 4/)).toBeTruthy();
    rerender(
      <NeighbourTray items={[item({ key: "a" })]} total={4} done onPick={noop} onClose={noop} />
    );
    expect(screen.getByText(/Around this page · 1 neighbour/)).toBeTruthy();
  });

  it("hides trailing pending slots once done (no perpetual shimmer on partial failure)", () => {
    // total 4, only 2 arrived: while blooming there are pending slots; once
    // done (a neighbour failed) they must disappear.
    const items = [item({ key: "a" }), item({ key: "b" })];
    const { container, rerender } = render(
      <NeighbourTray items={items} total={4} done={false} onPick={noop} onClose={noop} />
    );
    expect(container.querySelectorAll("[aria-hidden]").length).toBe(2);
    rerender(
      <NeighbourTray items={items} total={4} done onPick={noop} onClose={noop} />
    );
    expect(container.querySelectorAll("[aria-hidden]").length).toBe(0);
  });

  it("fires onPick with the item when a saved card is clicked", () => {
    const onPick = vi.fn();
    const it1 = item({ key: "a", subject: "The Factory", nodeId: "node-42" });
    render(
      <NeighbourTray items={[it1]} total={1} done onPick={onPick} onClose={noop} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Explore The Factory" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-42" }));
  });

  it("disables a card until it's persisted (no dead clicks)", () => {
    const onPick = vi.fn();
    // Image arrived but not yet persisted (nodeId null) → not clickable.
    const it1 = item({ subject: "Pending", imageDataUrl: "data:image/jpeg;base64,x", nodeId: null });
    render(<NeighbourTray items={[it1]} total={1} done onPick={onPick} onClose={noop} />);
    const btn = screen.getByRole("button", { name: "Explore Pending" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("disables a still-generating card (no image yet)", () => {
    const it1 = item({ subject: "Loading", imageDataUrl: null, nodeId: null });
    render(<NeighbourTray items={[it1]} total={1} done={false} onPick={noop} onClose={noop} />);
    const btn = screen.getByRole("button", { name: "Explore Loading" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("fires onClose from the close button", () => {
    const onClose = vi.fn();
    render(<NeighbourTray items={[item()]} total={1} done onPick={noop} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close neighbours" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says how many neighbours failed instead of pretending nothing was lost", () => {
    const ok = item({ subject: "Made it", imageDataUrl: "data:x", nodeId: "n1" });
    render(
      <NeighbourTray items={[ok]} total={3} done failed={2} onPick={noop} onClose={noop} />
    );
    expect(screen.getByText(/2 failed/)).toBeTruthy();
  });

  it("all-failed bloom says so, not 'no neighbours found'", () => {
    render(
      <NeighbourTray items={[]} total={3} done failed={3} onPick={noop} onClose={noop} />
    );
    expect(screen.getByText(/Couldn't draw the neighbours/)).toBeTruthy();
    expect(screen.queryByText(/No neighbours found nearby/)).toBeNull();
  });

  it("failed=0 renders the normal done status (byte-compat)", () => {
    const ok = item({ subject: "Fine", imageDataUrl: "data:x", nodeId: "n1" });
    render(
      <NeighbourTray items={[ok]} total={1} done failed={0} onPick={noop} onClose={noop} />
    );
    expect(screen.queryByText(/failed/)).toBeNull();
  });
});
