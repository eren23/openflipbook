"use client";

import { useCallback, useEffect, useState } from "react";

import { getStylePreset, presetNodeId } from "@/lib/styles";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

export interface StyleAnchor {
  nodeId: string;
  style: string;
}

export interface PinTarget {
  nodeId: string | null;
  imageDataUrl: string | null;
  title: string;
  query: string | null;
}

function storageKey(sessionId: string): string {
  return `openflipbook.styleAnchor.${sessionId}`;
}

/**
 * Persisted style-DNA anchor for a session. Hydrate from localStorage on
 * mount/sessionId change; persist on every mutation. Toggle behaviour:
 * pinning the same nodeId clears, pinning a new one fetches the VLM style
 * caption via /api/resolve-click and stores it.
 */
export function useStyleAnchor(sessionId: string) {
  const [anchor, setAnchor] = useState<StyleAnchor | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey(sessionId));
      if (!raw) {
        setAnchor(null);
        return;
      }
      const parsed = JSON.parse(raw) as { nodeId?: string; style?: string };
      if (parsed?.nodeId && parsed?.style) {
        setAnchor({ nodeId: parsed.nodeId, style: parsed.style });
      }
    } catch {
      /* malformed — ignore */
    }
  }, [sessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = storageKey(sessionId);
    try {
      if (anchor) window.localStorage.setItem(key, JSON.stringify(anchor));
      else window.localStorage.removeItem(key);
    } catch {
      /* full disk / private mode — accept the loss */
    }
  }, [anchor, sessionId]);

  const togglePin = useCallback(
    async (page: PinTarget): Promise<void> => {
      if (!page.imageDataUrl || !page.nodeId) return;
      if (anchor && anchor.nodeId === page.nodeId) {
        setAnchor(null);
        return;
      }
      setPending(true);
      try {
        const trace = newTraceId();
        const res = await fetch("/api/resolve-click", {
          method: "POST",
          headers: { "Content-Type": "application/json", [TRACE_HEADER]: trace },
          body: JSON.stringify({
            image_data_url: page.imageDataUrl,
            x_pct: 0.5,
            y_pct: 0.5,
            parent_title: page.title,
            parent_query: page.query,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { style?: string };
        const style = (data.style || "").trim();
        if (!style) throw new Error("empty style");
        setAnchor({ nodeId: page.nodeId, style });
      } catch {
        // best-effort — leave anchor unchanged on failure
      } finally {
        setPending(false);
      }
    },
    [anchor],
  );

  const setFromPreset = useCallback((presetId: string): void => {
    const preset = getStylePreset(presetId);
    if (!preset) return;
    setAnchor({ nodeId: presetNodeId(preset.id), style: preset.promptFragment });
  }, []);

  return { anchor, setAnchor, pending, togglePin, setFromPreset } as const;
}
