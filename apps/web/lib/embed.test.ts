import { describe, expect, it } from "vitest";

import { buildEmbedHtml, parseEmbedTarget } from "./embed";

describe("parseEmbedTarget", () => {
  it("resolves /n/<id> permalinks to a node target on any origin", () => {
    expect(
      parseEmbedTarget("https://openflipbook.example/n/abc-123")
    ).toEqual({ kind: "node", nodeId: "abc-123" });
    expect(parseEmbedTarget("http://localhost:3000/n/xyz")).toEqual({
      kind: "node",
      nodeId: "xyz",
    });
  });

  it("resolves /embed/<sessionId> with an optional start node", () => {
    expect(parseEmbedTarget("https://x.test/embed/sess-1")).toEqual({
      kind: "session",
      sessionId: "sess-1",
      nodeId: null,
    });
    expect(parseEmbedTarget("https://x.test/embed/sess-1?node=n9")).toEqual({
      kind: "session",
      sessionId: "sess-1",
      nodeId: "n9",
    });
  });

  it("accepts relative paths (the /n/ discovery link's shape)", () => {
    expect(parseEmbedTarget("/n/abc")).toEqual({ kind: "node", nodeId: "abc" });
    expect(parseEmbedTarget("/embed/s1?node=n2")).toEqual({
      kind: "session",
      sessionId: "s1",
      nodeId: "n2",
    });
  });

  it("rejects everything else (other routes, missing ids)", () => {
    for (const bad of [
      "https://x.test/play?continue=s1",
      "https://x.test/n/",
      "https://x.test/embed/",
      "https://x.test/n/a/b",
      "::not a url::",
    ]) {
      expect(parseEmbedTarget(bad)).toBeNull();
    }
  });
});

describe("buildEmbedHtml", () => {
  it("builds the iframe with clamped width and 16:10 height", () => {
    const e = buildEmbedHtml("https://x.test/", "s1", "n2", 2000);
    expect(e.width).toBe(1280);
    expect(e.height).toBe(800);
    expect(e.html).toContain('src="https://x.test/embed/s1?node=n2"');
    expect(e.html).toContain("iframe");
  });

  it("defaults to 720 wide and omits the node param when absent", () => {
    const e = buildEmbedHtml("https://x.test", "s1", null);
    expect(e.width).toBe(720);
    expect(e.html).toContain('src="https://x.test/embed/s1"');
  });
});
