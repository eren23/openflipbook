import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const base = {
  x: 12,
  y: 34,
  beaconsHidden: false,
  canCopy: true,
  canPrune: true,
  canSavePostcard: true,
  onCopyPermalink: () => {},
  onPrune: () => {},
  onToggleBeacons: () => {},
  onSavePostcard: () => {},
  onClose: () => {},
};

describe("ContextMenu extraItems (parent-injected actions)", () => {
  it("renders injected items — e.g. 🔍 Zoom in here — and fires their onClick", () => {
    const onZoom = vi.fn();
    const extraItems: ContextMenuItem[] = [
      { label: "🔍 Zoom in here", onClick: onZoom },
    ];
    render(<ContextMenu {...base} extraItems={extraItems} />);
    fireEvent.click(screen.getByText("🔍 Zoom in here"));
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  it("keeps the page-level actions below the injected section", () => {
    render(
      <ContextMenu
        {...base}
        extraItems={[{ label: "🔍 Zoom in here", onClick: () => {} }]}
      />
    );
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    expect(labels.indexOf("🔍 Zoom in here")).toBeLessThan(
      labels.indexOf("Copy permalink")
    );
  });

  it("renders no injected section when extraItems is empty", () => {
    render(<ContextMenu {...base} extraItems={[]} />);
    expect(screen.queryByText("🔍 Zoom in here")).toBeNull();
    expect(screen.getByText("Copy permalink")).toBeTruthy();
  });
});
