import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TapHint } from "./TapHint";

/**
 * The tap-hint used to be a full-width, left-aligned bar that the bottom-corner
 * buttons (📌 Pin style / "localize now") sat on top of, hiding the text. These
 * pin the three properties of the fix so it can't silently regress.
 */
describe("TapHint", () => {
  it("renders the hint copy", () => {
    render(<TapHint text="Tap anywhere on the image to explore." />);
    expect(screen.getByText(/tap anywhere on the image to explore/i)).toBeTruthy();
  });

  it("does not capture pointer events — a tap on the bottom strip still explores", () => {
    const { container } = render(<TapHint text="x" />);
    const cap = container.querySelector("figcaption");
    expect(cap?.className).toContain("pointer-events-none");
  });

  it("is centered so it clears the bottom-corner buttons", () => {
    const { container } = render(<TapHint text="x" />);
    expect(container.querySelector("figcaption")?.className).toContain("justify-center");
  });

  it("wraps the copy in a readable, truncating pill (its own background, capped width)", () => {
    const { container } = render(<TapHint text="x" />);
    const pill = container.querySelector("figcaption > span");
    expect(pill?.className).toContain("truncate");
    expect(pill?.className).toMatch(/bg-black\/\d+/); // own backdrop so it's legible over any art
    expect(pill?.className).toMatch(/max-w-/); // doesn't stretch into the corners
  });
});
