import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FirstRunCoach } from "./FirstRunCoach";

/**
 * The coach chip is where a first-timer learns the two generative moves. It
 * must teach the *pair* — tap goes in (depth), Around blooms outward (breadth)
 * — not just tapping, which is the gap that made "what does Expand do" unclear.
 */
describe("FirstRunCoach", () => {
  it("teaches both moves: go in (tap) and around (the breadth action)", () => {
    render(<FirstRunCoach onShowHelp={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(/go in/i.test(text)).toBe(true); // the depth move (tap)
    expect(/around/i.test(text)).toBe(true); // the breadth move
    expect(screen.getByText("E")).toBeTruthy(); // the Around hotkey is surfaced
  });

  it("pre variant nudges a first query before any page exists", () => {
    render(<FirstRunCoach onShowHelp={() => {}} variant="pre" />);
    const text = document.body.textContent ?? "";
    expect(/ask anything above/i.test(text)).toBe(true);
    expect(/first page/i.test(text)).toBe(true);
    expect(/tap anywhere/i.test(text)).toBe(true);
    expect(/around/i.test(text)).toBe(false);
  });

  it("opens help from the ? button", () => {
    const onShowHelp = vi.fn();
    render(<FirstRunCoach onShowHelp={onShowHelp} />);
    fireEvent.click(screen.getByRole("button", { name: /shortcut/i }));
    expect(onShowHelp).toHaveBeenCalledTimes(1);
  });

  it("world mode adds the enter-rings hint; classic mode never shows it", () => {
    const world = render(<FirstRunCoach onShowHelp={() => {}} worldHint />);
    expect(/rings = enterable places/i.test(document.body.textContent ?? "")).toBe(
      true,
    );
    world.unmount();
    render(<FirstRunCoach onShowHelp={() => {}} />);
    expect(/rings/i.test(document.body.textContent ?? "")).toBe(false);
  });
});
