import { describe, expect, it, vi } from "vitest";
import { loadCreatorSession } from "./creator-resume";

const row = (i: number) => ({ id: `n${i}`, parent_id: i ? `n${i - 1}` : null, session_id: "world", page_title: `View ${i}`, query: "map", image_url: "/saved.jpg", image_key: "saved.jpg", click_in_parent: null, geo_extracted: false });
const reply = (nodes: unknown[], next_cursor: string | null = null) => new Response(JSON.stringify({ nodes, next_cursor }));
describe("creator resume", () => {
  it("loads beyond 200 nodes, opens the selected view and restores ancestry", async () => {
    const request = vi.fn().mockResolvedValueOnce(reply(Array.from({ length: 200 }, (_, i) => row(i)), "200")).mockResolvedValueOnce(reply([row(200), row(201)]));
    const result = await loadCreatorSession("world", "n201", new AbortController().signal, request);
    expect(result.history.items).toHaveLength(202); expect(result.history.trail).toHaveLength(202);
    expect(result.page.nodeId).toBe("n201"); expect(result.page.geoExtracted).toBe(false);
    expect(request.mock.calls[1]?.[0]).toContain("cursor=200");
  });
  it("restores an earlier chosen node and falls back to newest when it is missing", async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(reply([row(0), row(1)])));
    expect((await loadCreatorSession("world", "n0", new AbortController().signal, request)).page.nodeId).toBe("n0");
    expect((await loadCreatorSession("world", "gone", new AbortController().signal, request)).page.nodeId).toBe("n1");
  });
  it("rejects failed, empty, foreign and looping pages without generation", async () => {
    for (const response of [new Response("", { status: 503 }), reply([]), reply([{ ...row(0), session_id: "other" }]), new Response('{}')]) {
      await expect(loadCreatorSession("world", null, new AbortController().signal, vi.fn().mockResolvedValue(response))).rejects.toThrow();
    }
    await expect(loadCreatorSession("world", null, new AbortController().signal, vi.fn().mockImplementation(() => Promise.resolve(reply([row(0)], "again"))))).rejects.toThrow("pagination");
  });
  it("cancels before installing a saved view", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(loadCreatorSession("world", null, ac.signal, vi.fn().mockResolvedValue(reply([row(0)])))).rejects.toThrow();
  });
});
