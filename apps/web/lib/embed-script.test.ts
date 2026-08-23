import { beforeEach, describe, expect, it, vi } from "vitest";

// public/embed.js is the one shipped file nothing imports — a self-contained
// IIFE for third-party pages. Importing it in jsdom EXECUTES it against the
// prepared DOM, so the wrapper's contract (URL mapping, the _from-node
// sentinel, no double-mounting, width clamp) gets a real gate.

function target(url: string): HTMLDivElement {
  const div = document.createElement("div");
  div.setAttribute("data-openflipbook", url);
  document.body.appendChild(div);
  return div;
}

async function runScript(): Promise<void> {
  vi.resetModules(); // re-run the IIFE for each scenario
  // @ts-expect-error — not a module on purpose; importing EXECUTES the IIFE
  await import("../public/embed.js");
}

function frame(): HTMLIFrameElement | null {
  return document.querySelector("iframe");
}

describe("public/embed.js", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    // happy-dom would otherwise fetch every mounted iframe's src for real.
    (
      window as unknown as {
        happyDOM: { settings: { disableIframePageLoading: boolean } };
      }
    ).happyDOM.settings.disableIframePageLoading = true;
  });

  it("mounts an /embed/ link as an iframe, preserving the query", async () => {
    target("https://x.test/embed/s1?node=n2");
    await runScript();
    const f = frame()!;
    expect(f.src).toBe("https://x.test/embed/s1?node=n2");
    expect(f.title).toBe("openflipbook world");
  });

  it("maps /n/<id> permalinks through the _from-node sentinel", async () => {
    target("https://x.test/n/abc");
    await runScript();
    expect(frame()!.src).toBe("https://x.test/embed/_from-node?node=abc");
  });

  it("marks the div mounted and never double-mounts on a rescan", async () => {
    const div = target("https://x.test/n/abc");
    await runScript();
    await runScript(); // second script include on the same page
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(div.getAttribute("data-ofb-mounted")).toBe("1");
  });

  it("leaves unrecognized targets inert (no iframe, no mounted mark)", async () => {
    const div = target("https://x.test/play?continue=s1");
    await runScript();
    expect(frame()).toBeNull();
    expect(div.getAttribute("data-ofb-mounted")).toBeNull();
  });

  it("clamps the iframe width into [320, 1280] with a 16:10 height", async () => {
    target("https://x.test/n/abc");
    await runScript();
    const f = frame()!;
    // jsdom reports clientWidth 0 → the 720 default applies.
    expect(f.width).toBe("720");
    expect(f.height).toBe("450");
  });
});
