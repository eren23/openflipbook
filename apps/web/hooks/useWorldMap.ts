"use client";

import { useCallback, useEffect, useState } from "react";

import type { WorldMapSnapshot } from "@openflipbook/config";

import { TRACE_HEADER, newTraceId } from "@/lib/trace";

function emptyMap(sessionId: string): WorldMapSnapshot {
  return {
    session_id: sessionId,
    entities: [],
    bounds: { x: 0, y: 0, w: 0, h: 0 },
    schema_version: 1,
    updated_at: new Date(0).toISOString(),
  };
}

/**
 * Hydrate the session's geometric world map (entity coordinates). Inert when
 * GEOMETRIC_WORLD is off (the route returns an empty map). Refetch after a
 * generation seeds new geometry. Mirrors the fetch shape of useWorldState.
 */
export function useWorldMap(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<WorldMapSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!sessionId) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/world/${sessionId}/map`, {
        headers: { [TRACE_HEADER]: newTraceId() },
      });
      if (res.ok) setSnapshot((await res.json()) as WorldMapSnapshot);
    } catch {
      /* best-effort — leave the prior snapshot */
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return {
    snapshot: snapshot ?? (sessionId ? emptyMap(sessionId) : null),
    entities: snapshot?.entities ?? [],
    bounds: snapshot?.bounds ?? { x: 0, y: 0, w: 0, h: 0 },
    loading,
    refetch,
  } as const;
}
