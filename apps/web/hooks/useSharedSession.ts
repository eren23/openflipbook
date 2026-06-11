"use client";

import { useEffect, useRef, useState } from "react";

export interface IncomingNode {
  id: string;
  parent_id: string | null;
  title: string;
}

export interface SharedSessionState {
  /** Live viewer count (this tab included); null until the feed says hello. */
  viewers: number | null;
  /** The latest node another viewer added that THIS tab hasn't visited —
   * surfaced as a click-to-open chip; null when caught up. */
  incoming: IncomingNode | null;
  clearIncoming: () => void;
}

/** Read-along shared sessions (Wave 8): subscribes to the session's
 * change-stream feed + heartbeats presence while the tab is open. Degrades
 * to {viewers: null} silently on a standalone Mongo (the feed says
 * `unsupported` once and ends). `knownNodeIds` keeps this tab's own pages
 * from echoing back as "incoming". */
export function useSharedSession(
  sessionId: string | null,
  knownNodeIds: ReadonlySet<string>,
): SharedSessionState {
  const [viewers, setViewers] = useState<number | null>(null);
  const [incoming, setIncoming] = useState<IncomingNode | null>(null);
  const viewerIdRef = useRef<string>("");
  const knownRef = useRef(knownNodeIds);
  knownRef.current = knownNodeIds;

  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    if (!viewerIdRef.current) {
      viewerIdRef.current =
        window.crypto?.randomUUID?.() ?? `v_${Math.random().toString(36).slice(2)}`;
    }
    const viewerId = viewerIdRef.current;
    let stopped = false;

    const beat = () => {
      void fetch(`/api/session/${encodeURIComponent(sessionId)}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewer_id: viewerId }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { viewers?: number } | null) => {
          if (!stopped && j && typeof j.viewers === "number") {
            setViewers(j.viewers);
          }
        })
        .catch(() => {});
    };
    beat();
    const beatTimer = window.setInterval(beat, 20_000);

    const es = new EventSource(
      `/api/session/${encodeURIComponent(sessionId)}/events`,
    );
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as
          | { type: "hello" | "presence"; viewers?: number }
          | { type: "unsupported" }
          | { type: "node_added"; node: IncomingNode };
        if (evt.type === "unsupported") {
          es.close();
          return;
        }
        if (evt.type === "node_added") {
          if (!knownRef.current.has(evt.node.id)) setIncoming(evt.node);
          return;
        }
        if (typeof evt.viewers === "number") setViewers(evt.viewers);
      } catch {
        // malformed frame: skip
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do
    };

    return () => {
      stopped = true;
      window.clearInterval(beatTimer);
      es.close();
    };
  }, [sessionId]);

  return {
    viewers,
    incoming,
    clearIncoming: () => setIncoming(null),
  };
}
