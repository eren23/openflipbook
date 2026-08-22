import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TourPlayer from "./tour-player";
import type { TourNode } from "@/lib/tour";

function node(
  id: string,
  parent: string | null,
  created: string,
  click: { x_pct: number; y_pct: number } | null = parent
    ? { x_pct: 0.25, y_pct: 0.75 }
    : null
): TourNode {
  return {
    id,
    parent_id: parent,
    page_title: `Title ${id}`,
    image_url: `https://r2/${id}.jpg`,
    click_in_parent: click,
    relation: parent ? "descend" : null,
    created_at: created,
  };
}

const WORLD = [node("root", null, "2026-01-01"), node("kid", "root", "2026-01-02")];

describe("TourPlayer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds on the first page, dives at the tap point, then advances", async () => {
    render(
      <TourPlayer nodes={WORLD} continueUrl="/play?continue=s" onClose={() => {}} />
    );
    const img = screen.getByAltText("Title root");
    // Hold phase: gentle drift, transform-origin aimed at the NEXT tap point.
    expect(img.style.transform).toBe("scale(1.06)");
    expect(img.style.transformOrigin).toBe("25% 75%");

    await act(async () => {
      vi.advanceTimersByTime(2700); // hold elapses -> dive
    });
    expect(screen.getByAltText("Title root").style.transform).toBe("scale(2.4)");

    await act(async () => {
      vi.advanceTimersByTime(1000); // dive elapses -> next step
    });
    expect(screen.getByAltText("Title kid")).toBeTruthy();
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("ends on the card with replay + the continue funnel", async () => {
    render(
      <TourPlayer nodes={WORLD} continueUrl="/play?continue=s" onClose={() => {}} />
    );
    // The machine chains one setTimeout per phase — advance them in turn.
    for (const ms of [2700, 1000, 2700]) {
      await act(async () => {
        vi.advanceTimersByTime(ms); // root hold -> dive -> kid hold -> done
      });
    }
    const explore = screen.getByText("explore it yourself →");
    expect(explore.getAttribute("href")).toBe("/play?continue=s");
    // Replay rewinds to the first page.
    await act(async () => {
      fireEvent.click(screen.getByText("↻ replay"));
    });
    expect(screen.getByAltText("Title root")).toBeTruthy();
  });

  it("click skips ahead; Escape closes", async () => {
    const onClose = vi.fn();
    render(
      <TourPlayer nodes={WORLD} continueUrl="/play?continue=s" onClose={onClose} />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("tour-player"));
    });
    expect(screen.getByAltText("Title kid")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("prefers-reduced-motion drops every transform", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
    }));
    render(
      <TourPlayer nodes={WORLD} continueUrl="/play?continue=s" onClose={() => {}} />
    );
    expect(screen.getByAltText("Title root").style.transform).toBe("none");
    vi.unstubAllGlobals();
  });
});
