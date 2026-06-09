"use client";

import { useCallback, useRef, useState } from "react";

import type {
  GenerateAscendReadyEvent,
  GenerateEvent,
  ScaleTier,
  SceneView,
} from "@openflipbook/config";

import { MAP_IMAGE_FRAME } from "@/lib/geo-tap";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

export interface AscendRoot {
  nodeId: string;
  query: string;
  imageDataUrl: string;
  aspectRatio: string;
  sceneView?: SceneView | null;
}

export interface Ascended {
  parentNodeId: string;
  childNodeId: string;
  pageTitle: string;
  imageDataUrl: string;
  sceneView: SceneView;
  scaleTier: ScaleTier;
}

// Drain the SSE stream until the single `ascend_ready` lands (or an error).
async function readAscendReady(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<GenerateAscendReadyEvent | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (signal.aborted) return null;
      const evt = JSON.parse(payload) as GenerateEvent;
      if (evt.type === "ascend_ready") return evt;
      if (evt.type === "error") throw new Error(evt.message);
    }
  }
  return null;
}

/**
 * OUTWARD / zoom-out: synthesize the CONTAINER above the current root and persist
 * the reparent. Own fetch + SSE loop (independent of the page's `generate()`), so
 * tap/expand/edit are untouched. The backend `mode:"ascend"` branch streams a
 * single `ascend_ready` with the container image; we hand it to the web `/ascend`
 * route (which atomically inserts the parent node, re-roots the geo store, and
 * re-points the old root), then `onAscended` updates the live session.
 */
export function useAscend(onAscended: (a: Ascended) => void): {
  start: (sessionId: string, root: AscendRoot) => void;
  pending: boolean;
  error: string | null;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    (sessionId: string, root: AscendRoot) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setPending(true);
      setError(null);

      void (async () => {
        const traceId = newTraceId();
        try {
          // 1. Backend: synthesize the container image (outpaint / fresh).
          const res = await fetch("/api/generate-page", {
            method: "POST",
            headers: { "Content-Type": "application/json", [TRACE_HEADER]: traceId },
            body: JSON.stringify({
              query: root.query,
              session_id: sessionId,
              current_node_id: root.nodeId,
              mode: "ascend",
              image: root.imageDataUrl,
              scene_view: root.sceneView ?? null,
              aspect_ratio: root.aspectRatio,
              web_search: false,
              trace_id: traceId,
            }),
            signal: ac.signal,
          });
          if (!res.ok || !res.body) throw new Error(`ascend failed: HTTP ${res.status}`);
          const ready = await readAscendReady(res.body, ac.signal);
          if (ac.signal.aborted) return;
          if (!ready) throw new Error("no container was produced");

          // 2. Web route: persist the reparent atomically (both stores).
          const saveRes = await fetch(`/api/world/${sessionId}/ascend`, {
            method: "POST",
            headers: { "Content-Type": "application/json", [TRACE_HEADER]: traceId },
            body: JSON.stringify({
              child_node_id: root.nodeId,
              image_data_url: ready.image_data_url,
              parent_tier: ready.scale_tier,
              page_title: ready.page_title,
              query: ready.page_title,
              image_model: ready.image_model,
              final_prompt: ready.final_prompt,
              aspect_ratio: root.aspectRatio,
            }),
            signal: ac.signal,
          });
          if (!saveRes.ok) {
            const errBody = (await saveRes.json().catch(() => ({}))) as { error?: string };
            throw new Error(errBody.error || `persist failed: HTTP ${saveRes.status}`);
          }
          const saved = (await saveRes.json()) as { parent_node_id: string };
          if (ac.signal.aborted) return;

          onAscended({
            parentNodeId: saved.parent_node_id,
            childNodeId: root.nodeId,
            pageTitle: ready.page_title,
            imageDataUrl: ready.image_data_url,
            scaleTier: ready.scale_tier,
            sceneView: {
              node_id: saved.parent_node_id,
              level: "map",
              observer: null,
              map_crop: MAP_IMAGE_FRAME,
              focus_id: null,
              scale_tier: ready.scale_tier,
            },
          });
          setPending(false);
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          setError((err as Error).message);
          setPending(false);
        }
      })();
    },
    [onAscended],
  );

  return { start, pending, error };
}
