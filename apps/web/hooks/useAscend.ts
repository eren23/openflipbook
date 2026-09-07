"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  GenerateAscendReadyEvent,
  GenerateEvent,
  ScaleTier,
  SceneView,
  GenerateErrorEvent,
} from "@openflipbook/config";

import { MAP_IMAGE_FRAME } from "@/lib/geo-tap";
import { sseData } from "@/lib/sse";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";
import { isVerifiedView } from "@/lib/place-identity";

const STRICT_WORLD = /^(1|true|yes|on)$/i.test(process.env.NEXT_PUBLIC_WORLD_IDENTITY_STRICT ?? "");

class RejectedAscend extends Error {
  constructor(public event: GenerateErrorEvent) { super(event.message); }
}

export interface AscendRoot {
  nodeId: string;
  query: string;
  imageDataUrl: string;
  aspectRatio: string;
  sceneView?: SceneView | null;
  // The session style lock — the ascend used to be the ONE generate that
  // didn't send it, so the container render only had the weak "same style
  // as the centre" fallback holding the medium.
  styleAnchor?: string | null;
  // DOM-labels mode: ask for a label-free container map like every other
  // map render (the un-suppressed ascend baked hallucinated title lettering).
  suppressMapLabels?: boolean;
  // Consecutive OUTWARD hops taken in this chain (0 = first). The backend
  // re-anchors past SCALE_OUTWARD_MAX_HOPS so a long zoom-out chain doesn't
  // drift off the original medium.
  outwardDepth?: number;
  // Semantic identity for generic/uploaded roots. Without this, the backend
  // only sees "Uploaded image" and may invent a container for a placeholder.
  outwardContext?: string | null;
}

export interface Ascended {
  parentNodeId: string;
  childNodeId: string;
  pageTitle: string;
  imageDataUrl: string;
  sceneView: SceneView;
  scaleTier: ScaleTier;
  // The container shipped without a critic verdict (judge failure) — the
  // page surfaces an "unverified render" chip.
  renderUnjudged: boolean;
}

// Drain the SSE stream until the single `ascend_ready` lands (or an error).
async function readAscendReady(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<GenerateAscendReadyEvent | null> {
  for await (const payload of sseData(body)) {
    if (signal.aborted) return null;
    const evt = JSON.parse(payload) as GenerateEvent;
    if (evt.type === "ascend_ready") return evt;
    if (evt.type === "error") throw new RejectedAscend(evt);
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
export function useAscend(onAscended: (a: Ascended) => void, activeNodeId?: string | null): {
  start: (sessionId: string, root: AscendRoot) => void;
  pending: boolean;
  error: string | null;
  candidate: string | null;
  dismiss: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    abortRef.current?.abort();
    setPending(false);
    setError(null);
    setCandidate(null);
  }, [activeNodeId]);

  const start = useCallback(
    (sessionId: string, root: AscendRoot) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setPending(true);
      setError(null);
      setCandidate(null);

      void (async () => {
        const traceId = newTraceId();
        try {
          // 1. Backend: synthesize the container image (outpaint / fresh).
          const res = await fetch("/api/generate-page", {
            method: "POST",
            headers: { "Content-Type": "application/json", [TRACE_HEADER]: traceId, "Idempotency-Key": traceId },
            body: JSON.stringify({
              query: root.query,
              session_id: sessionId,
              current_node_id: root.nodeId,
              mode: "ascend",
              ...(STRICT_WORLD ? { strict_world: true, world_mode: true } : {}),
              image: root.imageDataUrl,
              scene_view: root.sceneView ?? null,
              aspect_ratio: root.aspectRatio,
              web_search: false,
              ...(root.styleAnchor
                ? { session_style_anchor: root.styleAnchor }
                : {}),
              ...(root.suppressMapLabels ? { suppress_map_labels: true } : {}),
              ...(root.outwardDepth ? { outward_depth: root.outwardDepth } : {}),
              ...(root.outwardContext ? { outward_context: root.outwardContext } : {}),
              trace_id: traceId,
            }),
            signal: ac.signal,
          });
          if (!res.ok || !res.body) throw new Error(`ascend failed: HTTP ${res.status}`);
          const ready = await readAscendReady(res.body, ac.signal);
          if (ac.signal.aborted) return;
          if (!ready) throw new Error("no container was produced");
          if (STRICT_WORLD && (!isVerifiedView(ready.view_verdict, { outward: true }) || ready.render_unjudged)) {
            throw new RejectedAscend({ type: "error", message: "The wider view could not be verified. Your world is unchanged.", candidate_image_data_url: ready.image_data_url });
          }

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
            renderUnjudged: ready.render_unjudged === true,
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
          if (ac.signal.aborted || (err as Error).name === "AbortError") return;
          if (err instanceof RejectedAscend) setCandidate(err.event.candidate_image_data_url ?? null);
          setError((err as Error).message);
          setPending(false);
        }
      })();
    },
    [onAscended],
  );

  return { start, pending, error, candidate, dismiss: () => { setError(null); setCandidate(null); } };
}
