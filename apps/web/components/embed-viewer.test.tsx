import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import EmbedViewer from "./embed-viewer";

// The embed's unit half. The publish gate, oEmbed payload, and iframe
// behaviour live in e2e/embed.spec.ts; these cover the in-component logic
// the mock stack can't isolate: dot rendering from the children fetch,
// navigation + back stack, the frontier hint, and the receipt line.

const CHILDREN = [
  {
    id: "kid1",
    page_title: "The Tower",
    image_url: "https://r2/kid1.jpg",
    click_in_parent: { x_pct: 0.25, y_pct: 0.5 },
  },
  {
    id: "kid2",
    page_title: "The Harbor",
    image_url: "https://r2/kid2.jpg",
    click_in_parent: null, // no recorded tap — must NOT render a dot
  },
];

function stubChildren(byParent: Record<string, unknown[]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const id = url.match(/\/api\/nodes\/([^/]+)\/children/)?.[1] ?? "";
      return {
        ok: true,
        json: async () => ({ children: byParent[decodeURIComponent(id)] ?? [] }),
      };
    })
  );
}

const INITIAL = { id: "root", title: "The Map", imageUrl: "https://r2/root.jpg" };

afterEach(() => vi.unstubAllGlobals());

describe("EmbedViewer", () => {
  it("renders entry dots only for children with a recorded tap point", async () => {
    stubChildren({ root: CHILDREN });
    await act(async () => {
      render(
        <EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play?continue=s1" />
      );
    });
    expect(screen.getByTitle("Enter The Tower")).toBeTruthy();
    expect(screen.queryByTitle("Enter The Harbor")).toBeNull();
    expect(screen.getByText("1 place to enter")).toBeTruthy();
  });

  it("dot click navigates in; back returns to the parent", async () => {
    stubChildren({ root: CHILDREN, kid1: [] });
    await act(async () => {
      render(
        <EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play?continue=s1" />
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle("Enter The Tower"));
    });
    expect(screen.getByText("The Tower")).toBeTruthy();
    expect(screen.getByText("world frontier")).toBeTruthy(); // no children
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "← back" }));
    });
    expect(screen.getByText("The Map")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "← back" })).toBeNull();
  });

  it("a tap on unexplored ground shows the continue hint at the tap point", async () => {
    stubChildren({ root: [] });
    await act(async () => {
      render(
        <EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play?continue=s1" />
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("embed-stage"));
    });
    const hint = screen.getByText(/unexplored — continue this world/);
    expect(hint.getAttribute("href")).toBe("/play?continue=s1");
  });

  it("keeps rendering (dotless) when the children fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    await act(async () => {
      render(
        <EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play?continue=s1" />
      );
    });
    expect(screen.getByText("world frontier")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Continue this world/ })).toBeTruthy();
  });

  it("shows the receipt on the initial node only", async () => {
    stubChildren({ root: CHILDREN, kid1: [] });
    await act(async () => {
      render(
        <EmbedViewer
          sessionId="s1"
          initial={INITIAL}
          continueUrl="/play?continue=s1"
          initialReceipt="arrival verified — same place 9.0/10 · 1 attempt"
        />
      );
    });
    expect(screen.getByText(/arrival verified/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Enter The Tower"));
    });
    // Off the initial node the footer reverts to the generic line.
    expect(screen.queryByText(/arrival verified/)).toBeNull();
    expect(screen.getByText("an openflipbook world")).toBeTruthy();
  });
});
