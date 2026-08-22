import { describe, expect, it } from "vitest";

import { resolveEmbedStart } from "./embed-resolve";
import type { NodeRow, PublishedSessionRow } from "./db";

// The embed trust boundary as a table: publish gate, foreign-node
// rejection, the _from-node sentinel, and store-failure degradation.

const PUB: PublishedSessionRow = {
  session_id: "s1",
  node_id: "root1",
  title: "The Map",
  query: "a map",
  poster_key: "k/poster.jpg",
  published_at: "2026-08-22T00:00:00.000Z",
};

function node(id: string, session: string): NodeRow {
  return {
    id,
    parent_id: null,
    session_id: session,
    query: "q",
    page_title: `Title ${id}`,
    image_key: `k/${id}.jpg`,
    image_model: "m",
    prompt_author_model: "p",
    aspect_ratio: "16:9",
    final_prompt: null,
    click_in_parent: null,
    sources: [],
    relation: "descend",
    scale: "peer",
    scale_tier: null,
    scene_view: null,
    view_verdict: null,
    forked_from: null,
    geo_extracted: false,
    created_at: "2026-08-22T00:00:00.000Z",
  };
}

function stores(over: Partial<Parameters<typeof resolveEmbedStart>[2]> = {}) {
  return {
    getNode: async (id: string) =>
      id === "root1" ? node("root1", "s1") : id === "foreign" ? node("foreign", "s2") : null,
    getPublishedSession: async (sid: string) => (sid === "s1" ? PUB : null),
    getSessionRootNode: async (sid: string) =>
      sid === "s1" ? node("root1", "s1") : null,
    ...over,
  };
}

describe("resolveEmbedStart", () => {
  it("unpublished sessions resolve to null — private worlds are not frameable", async () => {
    expect(await resolveEmbedStart("s2", null, stores())).toBeNull();
  });

  it("published session starts at its root by default", async () => {
    const r = await resolveEmbedStart("s1", null, stores());
    expect(r?.start.id).toBe("root1");
  });

  it("a foreign ?node= cannot smuggle a page into the published frame", async () => {
    const r = await resolveEmbedStart("s1", "foreign", stores());
    // Falls back to the session's own root instead of the foreign page.
    expect(r?.start.id).toBe("root1");
    expect(r?.start.session_id).toBe("s1");
  });

  it("_from-node resolves the node's session and STILL applies the gate", async () => {
    const ok = await resolveEmbedStart("_from-node", "root1", stores());
    expect(ok?.sessionId).toBe("s1");
    expect(ok?.start.id).toBe("root1");
    // A node in an unpublished session resolves the session, then gates out.
    expect(await resolveEmbedStart("_from-node", "foreign", stores())).toBeNull();
    // The sentinel without a node is meaningless.
    expect(await resolveEmbedStart("_from-node", null, stores())).toBeNull();
  });

  it("store failures degrade to null, never to an error shape", async () => {
    const boom = stores({
      getPublishedSession: async () => {
        throw new Error("mongo down");
      },
    });
    expect(await resolveEmbedStart("s1", null, boom)).toBeNull();
  });
});
