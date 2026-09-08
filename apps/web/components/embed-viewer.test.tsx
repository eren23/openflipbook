import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    click_in_parent: { x_pct: 0.25, y_pct: 0.25 },
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

let resize: () => void;
let width: number;
let height: number;

beforeEach(() => {
  width = 800;
  height = 600;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() =>
    ({ width, height, left: 0, top: 0, right: width, bottom: height } as DOMRect));
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(600);
  vi.stubGlobal("ResizeObserver", class {
    constructor(cb: () => void) { resize = cb; }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => {
    render(<EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play?continue=s1" />);
  });
  fireEvent.load(screen.getByRole("img"));
}

describe("EmbedViewer", () => {
  it("renders entry dots only for children with a recorded tap point", async () => {
    stubChildren({ root: CHILDREN });
    await act(async () => {
      render(
        <EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play?continue=s1" />
      );
    });
    fireEvent.load(screen.getByRole("img"));
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
    fireEvent.load(screen.getByRole("img"));
    await act(async () => {
      fireEvent.click(screen.getByTitle("Enter The Tower"));
    });
    expect(screen.getByText("The Tower")).toBeTruthy();
    expect(screen.getByText("world frontier")).toBeTruthy(); // no children
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
    });
    expect(screen.getByText("The Map")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("a tap on unexplored ground shows the continue hint at the tap point", async () => {
    stubChildren({ root: [] });
    await act(async () => {
      render(
        <EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play?continue=s1" />
      );
    });
    fireEvent.load(screen.getByRole("img"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("embed-stage"), { clientX: 400, clientY: 300 });
    });
    const hint = screen.getByText(/unexplored — continue this world/);
    expect(hint.getAttribute("href")).toBe("/play?continue=s1");
  });

  it("distinguishes a failed fetch from the frontier and retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    await act(async () => {
      render(
        <EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play?continue=s1" />
      );
    });
    expect(screen.getByText("Places unavailable")).toBeTruthy();
    expect(screen.queryByText("world frontier")).toBeNull();
    expect(screen.getByRole("link", { name: /Continue this world/ })).toBeTruthy();
    stubChildren({ root: [] });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry places" })); });
    expect(screen.getByText("world frontier")).toBeTruthy();
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
    fireEvent.load(screen.getByRole("img"));
    expect(screen.getByText(/arrival verified/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Enter The Tower"));
    });
    // Off the initial node the footer reverts to the generic line.
    expect(screen.queryByText(/arrival verified/)).toBeNull();
    expect(screen.getByText("an openflipbook world")).toBeTruthy();
  });

  it("positions markers within letterboxed pixels and recalculates on resize", async () => {
    stubChildren({ root: CHILDREN });
    await mount();
    const dot = screen.getByTitle("Enter The Tower");
    expect(dot.style.left).toBe("200px");
    expect(dot.style.top).toBe("200px");
    width = 400;
    height = 800;
    await act(async () => resize());
    expect(dot.style.left).toBe("100px");
    expect(dot.style.top).toBe("350px");
  });

  it("positions markers within pillarboxed portrait images", async () => {
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(600);
    stubChildren({ root: CHILDREN });
    await mount();
    expect(screen.getByTitle("Enter The Tower").style.left).toBe("325px");
    expect(screen.getByTitle("Enter The Tower").style.top).toBe("150px");
  });

  it("measures cached images that loaded before hydration", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    stubChildren({ root: CHILDREN });
    await act(async () => { render(<EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play" />); });
    expect(screen.getByTitle("Enter The Tower").style.left).toBe("200px");
  });

  it("ignores letterbox clicks and keeps edge hints and labels inside the stage", async () => {
    width = 320;
    height = 600;
    stubChildren({ root: CHILDREN });
    await mount();
    fireEvent.click(screen.getByTestId("embed-stage"), { clientX: 20, clientY: 10 });
    expect(screen.queryByText(/unexplored/)).toBeNull();
    fireEvent.focus(screen.getByTitle("Enter The Tower"));
    expect(screen.getByRole("tooltip").style.left).toBe("8px");
    fireEvent.click(screen.getByTestId("embed-stage"), { clientX: 319, clientY: 300 });
    const hint = screen.getByText(/unexplored/);
    expect(Number.parseFloat(hint.style.left) + Number.parseFloat(hint.style.width)).toBeLessThanOrEqual(312);
  });

  it("hides overlays until the current image loads, including after navigation", async () => {
    stubChildren({ root: CHILDREN, kid1: [{ ...CHILDREN[0], id: "nested" }] });
    await act(async () => { render(<EmbedViewer sessionId="s1" initial={INITIAL} continueUrl="/play" />); });
    expect(screen.queryByTitle("Enter The Tower")).toBeNull();
    fireEvent.load(screen.getByRole("img"));
    await act(async () => fireEvent.click(screen.getByTitle("Enter The Tower")));
    expect(screen.queryByTitle("Enter The Tower")).toBeNull();
    fireEvent.load(screen.getByRole("img"));
    expect(screen.getByTitle("Enter The Tower")).toBeTruthy();
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByTitle("Enter The Tower")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Image unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry image" }));
    fireEvent.load(screen.getByRole("img"));
    expect(screen.getByTitle("Enter The Tower")).toBeTruthy();
  });

  it("rejects malformed and out-of-range marker positions", async () => {
    stubChildren({ root: [null, ...[NaN, Infinity, -0.1, 1.1, "0.5"].map((x) => ({
      ...CHILDREN[0], click_in_parent: { x_pct: x, y_pct: 0.5 },
    }))] });
    await mount();
    expect(screen.queryByTitle("Enter The Tower")).toBeNull();
  });

  it("does not apply late child responses to a different node", async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ children: CHILDREN }) })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ children: CHILDREN }) }));
    await mount();
    await act(async () => fireEvent.click(screen.getByTitle("Enter The Tower")));
    expect(screen.getByText("Loading places...")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back" })));
    fireEvent.load(screen.getByRole("img"));
    await act(async () => finish({ ok: true, json: async () => ({ children: [] }) }));
    expect(screen.getByTitle("Enter The Tower")).toBeTruthy();
  });

  it("handles network errors and invalid response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ children: null }) }));
    await mount();
    expect(screen.getByText("Places unavailable")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry places" })));
    expect(screen.getByText("Places unavailable")).toBeTruthy();
  });
});
