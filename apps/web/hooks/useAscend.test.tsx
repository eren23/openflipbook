// OUTWARD nav: the two-fetch contract (backend synthesize → web persist),
// the optional body fields (style anchor / label suppression), the callback
// payload the page re-roots from, error surfacing, and re-start abort.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAP_IMAGE_FRAME } from "@/lib/geo-tap";

import { useAscend, type AscendRoot } from "./useAscend";

const READY = {
  type: "ascend_ready",
  page_title: "The Valley",
  image_data_url: "data:image/jpeg;base64,container",
  image_model: "m",
  prompt_author_model: "p",
  final_prompt: "fp",
  scale_tier: "region",
  from_tier: "city",
  session_id: "s1",
};

function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      controller.close();
    },
  });
}

interface StubOptions {
  events?: unknown[];
  generateOk?: boolean;
  saveOk?: boolean;
  saveJson?: unknown;
}

function stubFetch({
  events = [READY],
  generateOk = true,
  saveOk = true,
  saveJson = { parent_node_id: "parent-1" },
}: StubOptions = {}) {
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url) === "/api/generate-page") {
      return { ok: generateOk, status: generateOk ? 200 : 500, body: sseBody(events) };
    }
    return {
      ok: saveOk,
      status: saveOk ? 200 : 500,
      json: async () => saveJson,
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function root(over: Partial<AscendRoot> = {}): AscendRoot {
  return {
    nodeId: "child-1",
    query: "the town",
    imageDataUrl: "data:image/jpeg;base64,child",
    aspectRatio: "16:9",
    ...over,
  };
}

const bodyOf = (call: unknown[]): Record<string, unknown> =>
  JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAscend", () => {
  it("synthesizes, persists, then hands the reparent to onAscended", async () => {
    const fn = stubFetch();
    const onAscended = vi.fn();
    const { result } = renderHook(() => useAscend(onAscended));

    act(() => result.current.start("s1", root()));
    expect(result.current.pending).toBe(true);

    await waitFor(() => expect(onAscended).toHaveBeenCalledTimes(1));
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();

    // Fetch 1: the backend ascend branch.
    expect(String(fn.mock.calls[0]![0])).toBe("/api/generate-page");
    const gen = bodyOf(fn.mock.calls[0]!);
    expect(gen.mode).toBe("ascend");
    expect(gen.session_id).toBe("s1");
    expect(gen.current_node_id).toBe("child-1");
    expect(gen.image).toBe("data:image/jpeg;base64,child");
    expect(gen.aspect_ratio).toBe("16:9");
    expect(gen.web_search).toBe(false);

    // Fetch 2: the atomic reparent route, fed from ascend_ready.
    expect(String(fn.mock.calls[1]![0])).toBe("/api/world/s1/ascend");
    const save = bodyOf(fn.mock.calls[1]!);
    expect(save.child_node_id).toBe("child-1");
    expect(save.image_data_url).toBe(READY.image_data_url);
    expect(save.parent_tier).toBe("region");
    expect(save.page_title).toBe("The Valley");
    expect(save.query).toBe("The Valley");

    // The callback contract the page re-roots the session from.
    expect(onAscended).toHaveBeenCalledWith({
      parentNodeId: "parent-1",
      childNodeId: "child-1",
      pageTitle: "The Valley",
      imageDataUrl: READY.image_data_url,
      scaleTier: "region",
      renderUnjudged: false,
      sceneView: {
        node_id: "parent-1",
        level: "map",
        observer: null,
        map_crop: MAP_IMAGE_FRAME,
        focus_id: null,
        scale_tier: "region",
      },
    });
  });

  it("omits style anchor + label suppression unless armed, sends them when set", async () => {
    const fn = stubFetch();
    const onAscended = vi.fn();
    const { result } = renderHook(() => useAscend(onAscended));

    act(() => result.current.start("s1", root()));
    await waitFor(() => expect(onAscended).toHaveBeenCalledTimes(1));
    const bare = bodyOf(fn.mock.calls[0]!);
    expect("session_style_anchor" in bare).toBe(false);
    expect("suppress_map_labels" in bare).toBe(false);

    act(() =>
      result.current.start(
        "s1",
        root({ styleAnchor: "woodcut, sepia", suppressMapLabels: true }),
      ),
    );
    await waitFor(() => expect(onAscended).toHaveBeenCalledTimes(2));
    const armed = bodyOf(fn.mock.calls[2]!);
    expect(armed.session_style_anchor).toBe("woodcut, sepia");
    expect(armed.suppress_map_labels).toBe(true);
  });

  it("surfaces render_unjudged=true through the callback", async () => {
    stubFetch({ events: [{ ...READY, render_unjudged: true }] });
    const onAscended = vi.fn();
    const { result } = renderHook(() => useAscend(onAscended));
    act(() => result.current.start("s1", root()));
    await waitFor(() => expect(onAscended).toHaveBeenCalledTimes(1));
    expect(onAscended.mock.calls[0]![0].renderUnjudged).toBe(true);
  });

  it("reports an HTTP failure from the synthesize fetch", async () => {
    stubFetch({ generateOk: false });
    const onAscended = vi.fn();
    const { result } = renderHook(() => useAscend(onAscended));
    act(() => result.current.start("s1", root()));
    await waitFor(() => expect(result.current.error).toBe("ascend failed: HTTP 500"));
    expect(result.current.pending).toBe(false);
    expect(onAscended).not.toHaveBeenCalled();
  });

  it("propagates a stream error event's message", async () => {
    stubFetch({ events: [{ type: "error", message: "the judge quit" }] });
    const { result } = renderHook(() => useAscend(vi.fn()));
    act(() => result.current.start("s1", root()));
    await waitFor(() => expect(result.current.error).toBe("the judge quit"));
  });

  it("errors when the stream ends without ascend_ready", async () => {
    stubFetch({ events: [{ type: "status", message: "warming" }] });
    const { result } = renderHook(() => useAscend(vi.fn()));
    act(() => result.current.start("s1", root()));
    await waitFor(() =>
      expect(result.current.error).toBe("no container was produced"),
    );
  });

  it("surfaces the persist route's error body (no silent half-reparent)", async () => {
    stubFetch({ saveOk: false, saveJson: { error: "geo store said no" } });
    const onAscended = vi.fn();
    const { result } = renderHook(() => useAscend(onAscended));
    act(() => result.current.start("s1", root()));
    await waitFor(() => expect(result.current.error).toBe("geo store said no"));
    expect(onAscended).not.toHaveBeenCalled();
  });

  it("re-start aborts the in-flight ascend; only the new one lands", async () => {
    const onAscended = vi.fn();
    let generateCalls = 0;
    const fn = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/api/generate-page") {
        generateCalls += 1;
        if (generateCalls === 1) {
          // First ascend hangs like a slow backend; abort rejects it the way
          // real fetch does.
          return new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        }
        return Promise.resolve({ ok: true, status: 200, body: sseBody([READY]) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ parent_node_id: "parent-2" }),
      });
    });
    vi.stubGlobal("fetch", fn);

    const { result } = renderHook(() => useAscend(onAscended));
    act(() => result.current.start("s1", root({ nodeId: "first" })));
    act(() => result.current.start("s1", root({ nodeId: "second" })));

    await waitFor(() => expect(onAscended).toHaveBeenCalledTimes(1));
    expect(onAscended.mock.calls[0]![0].childNodeId).toBe("second");
    // The aborted run must not leak an error into the fresh one.
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });
});
