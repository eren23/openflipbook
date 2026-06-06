"use client";

import { useCallback } from "react";

import type { EntityEditPlan } from "@openflipbook/config";

import { useWorldMap } from "@/hooks/useWorldMap";
import { TRACE_HEADER, newTraceId } from "@/lib/trace";

import GeoEditPanel from "./GeoEditPanel";

interface Props {
  sessionId: string;
}

// Self-contained container for the geometric-world editor: hydrates the session
// map, wires the NL-edit route (preview via dry_run, then apply), refetches the
// chips after a write. Drop in behind WORLD_OVERRIDE_ENABLED + GEOMETRIC_WORLD;
// inert (empty map) when the geo flag is off, so it's safe to mount either way.
export default function GeoEditSection({ sessionId }: Props) {
  const { entities, refetch } = useWorldMap(sessionId);

  const onSubmit = useCallback(
    async (instruction: string, dryRun: boolean): Promise<EntityEditPlan> => {
      const res = await fetch(`/api/world/${sessionId}/edit-entities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TRACE_HEADER]: newTraceId(),
        },
        body: JSON.stringify({ instruction, dry_run: dryRun }),
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { plan: EntityEditPlan };
      if (!dryRun) void refetch(); // the map changed → reload the chips
      return payload.plan;
    },
    [sessionId, refetch],
  );

  return <GeoEditPanel entities={entities} onSubmit={onSubmit} />;
}
