import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SpeedPreset } from "./SpeedPreset";

const BALANCED = { maxAttempts: 2, verify: true };

function setup(over: Partial<Parameters<typeof SpeedPreset>[0]> = {}) {
  const setImageTier = vi.fn();
  const setKnobs = vi.fn();
  render(
    <SpeedPreset
      busy={false}
      imageTier="balanced"
      setImageTier={setImageTier}
      knobs={BALANCED}
      setKnobs={setKnobs}
      {...over}
    />,
  );
  return { setImageTier, setKnobs };
}

describe("SpeedPreset", () => {
  it("highlights the preset the current tier+knobs amount to", () => {
    setup();
    expect(
      screen.getByRole("button", { name: "balanced" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "fast" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("a preset click sets BOTH stores — tier and loop knobs", () => {
    const { setImageTier, setKnobs } = setup();
    fireEvent.click(screen.getByRole("button", { name: "quality" }));
    expect(setImageTier).toHaveBeenCalledWith("pro");
    expect(setKnobs).toHaveBeenCalledWith({ maxAttempts: 3, verify: true });
  });

  it("an off-bundle combo reads as custom", () => {
    setup({ knobs: { maxAttempts: 1, verify: true } });
    expect(screen.getByText("custom")).toBeTruthy();
  });

  it("the chip projects the balanced tap range from docs/COSTS.md", () => {
    setup();
    expect(screen.getByTestId("cost-chip").textContent).toContain(
      "$0.16–0.32",
    );
  });

  it("the chip collapses for the fast un-judged shot", () => {
    setup({ imageTier: "fast", knobs: { maxAttempts: 1, verify: false } });
    expect(screen.getByTestId("cost-chip").textContent).toMatch(/\$0\.05\/tap/);
  });

  it("the ⚙ popover exposes the knobs", () => {
    const { setKnobs } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Advanced loop controls" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "off" }));
    expect(setKnobs).toHaveBeenCalledWith({ maxAttempts: 2, verify: false });
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(setKnobs).toHaveBeenCalledWith({ maxAttempts: 3, verify: true });
  });
});

describe("session spend chip", () => {
  it("shows the backend's running estimate when present", () => {
    setup({ sessionSpend: 0.48 });
    expect(screen.getByTestId("session-spend").textContent).toContain(
      "session ≈ $0.48",
    );
  });

  it("absent until the first final frame lands", () => {
    setup();
    expect(screen.queryByTestId("session-spend")).toBeNull();
  });
});

describe("dev model dropdown", () => {
  it("absent without NEXT_PUBLIC_DEV_PROVIDERS (the default build)", () => {
    const { setKnobs } = setup({ setDevModel: () => {} });
    fireEvent.click(
      screen.getByRole("button", { name: "Advanced loop controls" }),
    );
    expect(screen.queryByLabelText("Dev image model override")).toBeNull();
    void setKnobs;
  });
});
