import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { STYLE_PRESETS } from "@/lib/styles";

import { StyleGallery } from "./StyleGallery";

describe("StyleGallery", () => {
  it("renders one tile per preset", () => {
    render(<StyleGallery onPick={() => {}} onSkip={() => {}} />);
    for (const p of STYLE_PRESETS) {
      expect(screen.getByText(p.name)).toBeTruthy();
    }
  });

  it("fires onPick with the preset id when a tile is clicked", () => {
    const onPick = vi.fn();
    render(<StyleGallery onPick={onPick} onSkip={() => {}} />);
    fireEvent.click(screen.getByText("Woodcut"));
    expect(onPick).toHaveBeenCalledWith("woodcut");
  });

  it("fires onSkip when the skip link is clicked", () => {
    const onSkip = vi.fn();
    render(<StyleGallery onPick={() => {}} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /^Skip/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("exposes role=button on each tile for keyboard / a11y", () => {
    render(<StyleGallery onPick={() => {}} onSkip={() => {}} />);
    const tiles = screen.getAllByRole("button", { name: /storybook|woodcut|cyberpunk|vintage|botanical|comic|noir|pixel|skip/i });
    expect(tiles.length).toBeGreaterThanOrEqual(STYLE_PRESETS.length);
  });
});
