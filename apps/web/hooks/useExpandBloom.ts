"use client";

import { useCallback, useRef, useState } from "react";

import type { GenerateEvent, GenerateRequestBody, ScaleKind } from "@openflipbook/config";

import type { NeighbourItem } from "@/components/PlayPage/NeighbourTray";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

export interface BloomState {
  items: NeighbourItem[];
  /** How many neighbours the bloom proposed (drives "N of M" + pending slots). */
  total: number;
  /** True once `expand_done` lands (or the stream errored out). */
  done: boolean;
}

/** Persists one bloomed neighbour as a relation:"expand" child and returns its
 *  node id. `app/play/page.tsx`'s `persistNode` satisfies this. */
export type PersistNeighbour = (
  body: {
    parent_id: string | null;
    session_id: string;
    query: string;
    page_title: string;
    image_data_url: string;
    image_model: string;
    prompt_author_model: string;
    aspect_ratio: string;
    final_prompt: string;
    relation: "expand";
    scale: ScaleKind;
  },
  traceId: string | null,
) => Promise<{ id: string } | null>;

/**
 * The "expand outward" bloom: own fetch + SSE loop, independent of the page's
 * main `generate()` so the tap/query/edit path is untouched. Neighbour pages
 * stream in via `neighbor` events, fill the tray, and persist as
 * relation:"expand" children; `expand_done` (or a stream error) ends it.
 *
 * `start(body)` aborts any prior bloom first, and `close()` aborts the live
 * one — so a late `neighbor` event can never resurrect a closed tray or mix
 * two blooms into one (the abort + the in-loop `aborted` guard both gate it).
 */
export function useExpandBloom(persist: PersistNeighbour): {
  bloom: BloomState | null;
  start: (body: GenerateRequestBody) => void;
  close: () => void;
} {
  const [bloom, setBloom] = useState<BloomState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    (body: GenerateRequestBody) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setBloom({ items: [], total: 0, done: false });

      void (async () => {
        const traceId = newTraceId();
        try {
          const response = await fetch("/api/generate-page", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [TRACE_HEADER]: traceId,
            },
            body: JSON.stringify({ ...body, trace_id: traceId }),
            signal: ac.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`expand failed: HTTP ${response.status}`);
          }
          const reader = response.body.getReader();
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
              const evt = JSON.parse(payload) as GenerateEvent;
              // Stop touching bloom state the moment this stream is superseded
              // / closed, so a buffered late event can't revive a closed tray.
              if (ac.signal.aborted) return;
              if (evt.type === "neighbor") {
                const item: NeighbourItem = {
                  key: `${body.current_node_id}-${evt.index}-${evt.subject}`,
                  subject: evt.subject,
                  scale: evt.scale,
                  imageDataUrl: evt.image_data_url,
                  nodeId: null,
                };
                setBloom((prev) => ({
                  items: [...(prev?.items ?? []), item],
                  total: evt.total,
                  done: prev?.done ?? false,
                }));
                void persist(
                  {
                    parent_id: body.current_node_id || null,
                    session_id: evt.session_id,
                    query: evt.subject,
                    page_title: evt.page_title,
                    image_data_url: evt.image_data_url,
                    image_model: evt.image_model,
                    prompt_author_model: evt.prompt_author_model,
                    aspect_ratio: body.aspect_ratio,
                    final_prompt: evt.final_prompt,
                    relation: "expand",
                    scale: evt.scale,
                  },
                  traceId,
                ).then((saved) => {
                  if (!saved) return;
                  setBloom((prev) =>
                    prev
                      ? {
                          ...prev,
                          items: prev.items.map((i) =>
                            i.key === item.key ? { ...i, nodeId: saved.id } : i,
                          ),
                        }
                      : prev,
                  );
                });
              } else if (evt.type === "expand_done") {
                setBloom((prev) => (prev ? { ...prev, done: true } : prev));
              } else if (evt.type === "error") {
                throw new Error(evt.message);
              }
            }
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          // A failed bloom shouldn't disturb the focal page — just stop the
          // tray's pending spinner and keep whatever neighbours arrived.
          setBloom((prev) => (prev ? { ...prev, done: true } : prev));
        }
      })();
    },
    [persist],
  );

  const close = useCallback(() => {
    abortRef.current?.abort();
    setBloom(null);
  }, []);

  return { bloom, start, close };
}
