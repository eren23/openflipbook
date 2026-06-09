import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenerateRequestBody } from "@openflipbook/config";

import { useExpandBloom, type PersistNeighbour } from "./useExpandBloom";

const BODY: GenerateRequestBody = {
  query: "how a steam engine works",
  aspect_ratio: "16:9",
  web_search: false,
  session_id: "s1",
  current_node_id: "n0",
  mode: "expand",
  image: "data:image/jpeg;base64,abc",
  parent_query: "how a steam engine works",
  parent_title: "Steam Engine",
};

function neighbor(over: Record<string, unknown> = {}): object {
  return {
    type: "neighbor",
    subject: "The Factory",
    scale: "container",
    page_title: "The Factory Floor",
    image_data_url: "data:image/jpeg;base64,xxx",
    image_model: "fal-model",
    prompt_author_model: "google/gemini-3-flash-preview",
    final_prompt: "an illustrated factory",
    session_id: "s1",
    index: 0,
    total: 2,
    ...over,
  };
}

function cannedResponse(events: object[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function manualResponse(): {
  response: Response;
  push: (e: object) => void;
  finish: () => void;
} {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  return {
    response: new Response(stream, { status: 200 }),
    push: (e) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)),
    finish: () => ctrl.close(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useExpandBloom", () => {
  it("fills the tray + persists each neighbour as a relation:expand child", async () => {
    const persist = vi.fn().mockResolvedValue({ id: "node-x" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        cannedResponse([
          { type: "status", stage: "planning" },
          neighbor({ subject: "The Factory", scale: "container", index: 0 }),
          neighbor({ subject: "Piston", scale: "peer", index: 1 }),
          { type: "expand_done", count: 2 },
        ]),
      ),
    );

    const { result } = renderHook(() =>
      useExpandBloom(persist as unknown as PersistNeighbour),
    );
    act(() => result.current.start(BODY));

    await waitFor(() => expect(result.current.bloom?.done).toBe(true));
    expect(result.current.bloom?.items.map((i) => i.subject)).toEqual([
      "The Factory",
      "Piston",
    ]);
    expect(result.current.bloom?.items.map((i) => i.scale)).toEqual(["container", "peer"]);
    expect(result.current.bloom?.total).toBe(2);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ relation: "expand", scale: "container", query: "The Factory" }),
      expect.anything(),
    );
    // nodeId back-patched once persist resolves.
    await waitFor(() =>
      expect(result.current.bloom?.items.every((i) => i.nodeId === "node-x")).toBe(true),
    );
  });

  it("persists scale_tier on each neighbour when the bloom is logical (around_tier)", async () => {
    const persist = vi.fn().mockResolvedValue({ id: "node-x" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        cannedResponse([
          neighbor({ subject: "The Library", scale: "peer", index: 0, total: 1 }),
          { type: "expand_done", count: 1 },
        ]),
      ),
    );
    const { result } = renderHook(() =>
      useExpandBloom(persist as unknown as PersistNeighbour),
    );
    act(() => result.current.start({ ...BODY, around_tier: "room" }));
    await waitFor(() => expect(result.current.bloom?.done).toBe(true));
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ relation: "expand", scale_tier: "room" }),
      expect.anything(),
    );
  });

  it("omits scale_tier for an unconstrained bloom (no around_tier)", async () => {
    const persist = vi.fn().mockResolvedValue({ id: "n" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        cannedResponse([neighbor({ index: 0, total: 1 }), { type: "expand_done", count: 1 }]),
      ),
    );
    const { result } = renderHook(() =>
      useExpandBloom(persist as unknown as PersistNeighbour),
    );
    act(() => result.current.start(BODY));
    await waitFor(() => expect(result.current.bloom?.done).toBe(true));
    expect("scale_tier" in (persist.mock.calls[0]![0] as object)).toBe(false);
  });

  it("resolves the bloom (done) when the stream closes without an expand_done", async () => {
    // Defensive: if the backend ever closes the stream without a terminal
    // expand_done (e.g. an early bail), the bloom must still flip to done so
    // Around re-enables and the tray shows its terminal state — not spin forever.
    const persist = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(cannedResponse([{ type: "status", stage: "planning" }])),
    );
    const { result } = renderHook(() =>
      useExpandBloom(persist as unknown as PersistNeighbour),
    );
    act(() => result.current.start(BODY));
    await waitFor(() => expect(result.current.bloom?.done).toBe(true));
    expect(result.current.bloom?.items).toEqual([]);
  });

  it("a stream error marks the bloom done instead of throwing", async () => {
    const persist = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(cannedResponse([{ type: "error", message: "boom" }])),
    );
    const { result } = renderHook(() =>
      useExpandBloom(persist as unknown as PersistNeighbour),
    );
    act(() => result.current.start(BODY));
    await waitFor(() => expect(result.current.bloom?.done).toBe(true));
    expect(result.current.bloom?.items).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });

  it("close() clears the tray and a late neighbour can't resurrect it", async () => {
    const persist = vi.fn().mockResolvedValue({ id: "n" });
    const m = manualResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(m.response));
    const { result } = renderHook(() =>
      useExpandBloom(persist as unknown as PersistNeighbour),
    );
    act(() => result.current.start(BODY));
    act(() => m.push(neighbor({ subject: "First", index: 0 })));
    await waitFor(() => expect(result.current.bloom?.items.length).toBe(1));

    act(() => result.current.close());
    expect(result.current.bloom).toBeNull();

    // Late event after close must be dropped (the abort + in-loop guard).
    await act(async () => {
      m.push(neighbor({ subject: "Late", index: 1 }));
      m.finish();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.bloom).toBeNull();
  });

  it("starting a new bloom replaces the prior tray", async () => {
    const persist = vi.fn().mockResolvedValue({ id: "n" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          cannedResponse([
            neighbor({ subject: "Old", index: 0, total: 1 }),
            { type: "expand_done", count: 1 },
          ]),
        )
        .mockResolvedValueOnce(
          cannedResponse([
            neighbor({ subject: "New", index: 0, total: 1 }),
            { type: "expand_done", count: 1 },
          ]),
        ),
    );
    const { result } = renderHook(() =>
      useExpandBloom(persist as unknown as PersistNeighbour),
    );
    act(() => result.current.start(BODY));
    await waitFor(() => expect(result.current.bloom?.items[0]?.subject).toBe("Old"));
    act(() => result.current.start(BODY));
    await waitFor(() => expect(result.current.bloom?.items[0]?.subject).toBe("New"));
    expect(result.current.bloom?.items.length).toBe(1);
  });
});
