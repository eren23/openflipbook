"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  Entity,
  WorldEntityMutation,
  WorldStateSnapshot,
} from "@openflipbook/config";

import { on, TRACE_HEADER } from "@/lib/trace";

export interface WorldStateView {
  entities: Entity[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
  // Server-derived flag — true when WORLD_OVERRIDE_ENABLED is set on the
  // deployment. The codex hides edit affordances when false so the user
  // never sees a button they aren't allowed to press.
  overrideEnabled: boolean;
  // Phase 7b — ids of recently-deleted entities. An optimistic
  // extraction_event arriving milliseconds after a delete would
  // otherwise re-add the entity as a stub; we suppress for a short
  // TTL until the canonical refetch settles. We track id → name so
  // `clear_recently_deleted` can evict the name when the id is cleared
  // — otherwise a long session accumulates names indefinitely and a
  // legitimate later "Torch" gets suppressed because some earlier
  // "Torch" was deleted hours ago.
  recentlyDeleted: Map<string, string>;
}

type WorldStateAction =
  | { type: "loading" }
  | {
      type: "loaded";
      snapshot: WorldStateSnapshot;
      override_enabled?: boolean;
    }
  | { type: "failed"; error: string }
  | {
      type: "extraction_event";
      added: Array<{ id: string; name: string; kind: Entity["kind"] }>;
      updated: Array<{ id: string; name: string; kind: Entity["kind"] }>;
    }
  | { type: "mark_recently_deleted"; id: string; name: string }
  | { type: "clear_recently_deleted"; id: string };

function reducer(state: WorldStateView, action: WorldStateAction): WorldStateView {
  switch (action.type) {
    case "loading":
      return { ...state, loading: true, error: null };
    case "loaded":
      return {
        entities: action.snapshot.entities,
        loading: false,
        error: null,
        updatedAt: action.snapshot.updated_at,
        overrideEnabled: action.override_enabled ?? state.overrideEnabled,
        recentlyDeleted: state.recentlyDeleted,
      };
    case "failed":
      return { ...state, loading: false, error: action.error };
    case "extraction_event": {
      // Coarse optimistic update from the digest the extract route emits.
      // Names + ids are reliable; the full Entity (appearance, facts,
      // state) lands on the next refetch. The HUD event is the
      // notification — refetch is what produces canonical state.
      if (!action.added.length && !action.updated.length) return state;
      const existing = new Map(state.entities.map((e) => [e.id, e]));
      let mutated = false;
      const deletedNames = new Set<string>();
      for (const name of state.recentlyDeleted.values()) {
        deletedNames.add(name.toLowerCase());
      }
      for (const a of action.added) {
        if (existing.has(a.id)) continue;
        // Phase 7b — drop optimistic stubs for entities the user just
        // tombstoned. Without this, a stale extraction event arriving
        // 100ms after a delete would zombie the entity back into the
        // codex until the canonical refetch lands. We match by id AND
        // by name (the extractor allocates a new id on re-add, but the
        // name is stable).
        if (state.recentlyDeleted.has(a.id)) continue;
        if (deletedNames.has(a.name.toLowerCase())) continue;
        existing.set(a.id, makeStubEntity(a));
        mutated = true;
      }
      // `updated` digests carry no field deltas, but they signal that the
      // canonical record is about to change. Demote the stale entry back
      // to "resolving" by blanking its appearance so the codex shows the
      // loading state until the debounced refetch fills it back in.
      for (const u of action.updated) {
        const target = existing.get(u.id);
        if (!target) continue;
        if (!target.appearance) continue;
        existing.set(u.id, { ...target, appearance: "" });
        mutated = true;
      }
      if (!mutated) return state;
      return {
        ...state,
        entities: Array.from(existing.values()),
        updatedAt: new Date().toISOString(),
      };
    }
    case "mark_recently_deleted": {
      const next = new Map(state.recentlyDeleted);
      next.set(action.id, action.name);
      return { ...state, recentlyDeleted: next };
    }
    case "clear_recently_deleted": {
      if (!state.recentlyDeleted.has(action.id)) return state;
      // Single-map eviction — clears both the id and its associated
      // name in one step so a long session doesn't accumulate
      // suppressions that silently drop later legitimate re-discoveries
      // of unrelated entities that happen to share a name.
      const next = new Map(state.recentlyDeleted);
      next.delete(action.id);
      return { ...state, recentlyDeleted: next };
    }
    default:
      return state;
  }
}

function makeStubEntity(digest: {
  id: string;
  name: string;
  kind: Entity["kind"];
}): Entity {
  // Placeholder until the canonical entity arrives via refetch. Marked
  // with empty appearance so the codex panel can render a "still
  // resolving…" state without flashing partial data.
  return {
    id: digest.id,
    kind: digest.kind,
    name: digest.name,
    aliases: [],
    appearance: "",
    reference_image_url: null,
    facts: [],
    state: {},
    first_seen_node_id: "",
    last_seen_node_id: "",
    appears_on_node_ids: [],
    appearance_bboxes: {},
    pinned_by_user: false,
    confidence: 0,
    updated_at: new Date().toISOString(),
  };
}

const initialState: WorldStateView = {
  entities: [],
  loading: false,
  error: null,
  updatedAt: null,
  overrideEnabled: false,
  recentlyDeleted: new Map<string, string>(),
};

/**
 * Hydrates the world-memory registry for `sessionId` and keeps it live
 * through HUD `world:extracted` events. Refetches the canonical snapshot
 * shortly after each extraction so optimistic stubs get filled in with
 * full appearance / facts / state from Mongo.
 *
 * Returns `{ state, refresh }`. `refresh` is a manual refetch trigger for
 * after user-override CRUD calls (Phase 5).
 */
export function useWorldState(sessionId: string | null) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Cancel in-flight fetches if the sessionId changes or the component
  // unmounts. AbortController-per-fetch avoids stale snapshots overwriting
  // a newer load when the user navigates between sessions quickly.
  const abortRef = useRef<AbortController | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of the latest entities-by-id so the delete path can look up
  // the name BEFORE the server's post-mutation snapshot replaces state.
  // A ref (not state) so writes don't trigger a re-render — this is
  // purely the lookup table for the `mark_recently_deleted` action.
  const priorEntityRef = useRef<Map<string, Entity>>(new Map());

  const fetchSnapshot = useCallback(async () => {
    if (!sessionId) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    dispatch({ type: "loading" });
    try {
      const res = await fetch(
        `/api/world/${encodeURIComponent(sessionId)}`,
        {
          method: "GET",
          headers: { [TRACE_HEADER]: "" },
          signal: ctl.signal,
        }
      );
      if (!res.ok) {
        dispatch({
          type: "failed",
          error: `HTTP ${res.status}`,
        });
        return;
      }
      const snapshot = (await res.json()) as WorldStateSnapshot & {
        override_enabled?: boolean;
      };
      dispatch({
        type: "loaded",
        snapshot,
        ...(typeof snapshot.override_enabled === "boolean"
          ? { override_enabled: snapshot.override_enabled }
          : {}),
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      dispatch({ type: "failed", error: (err as Error).message });
    }
  }, [sessionId]);

  /**
   * Fire a user-override CRUD mutation against the entity. Awaits the
   * server response and dispatches the canonical snapshot it returns.
   * Caller surface returns `{ ok, error? }` so the UI can show inline
   * validation without rethrowing into render.
   *
   * For `delete` ops we record the id + name in the recently-deleted
   * sets so a stale extraction event arriving shortly after can't
   * re-add the entity as an optimistic stub. The id is cleared either
   * by an `undo_delete` mutation (immediate) or after a short TTL.
   */
  const mutate = useCallback(
    async (
      mutation: WorldEntityMutation
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!sessionId) return { ok: false, error: "no active session" };
      try {
        const res = await fetch(
          `/api/world/${encodeURIComponent(sessionId)}/entity`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mutation),
          }
        );
        const text = await res.text();
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const body = JSON.parse(text) as { error?: string };
            if (body.error) msg = body.error;
          } catch {
            /* keep generic msg */
          }
          return { ok: false, error: msg };
        }
        if (text) {
          const snapshot = JSON.parse(text) as WorldStateSnapshot;
          // Capture the pre-mutation name BEFORE we overwrite state so a
          // zombie extraction event keyed on the old name can be
          // suppressed (the snapshot from the server already excludes
          // the entity for delete + the name from rename).
          if (mutation.op === "delete") {
            const before = priorEntityRef.current.get(mutation.id);
            if (before) {
              dispatch({
                type: "mark_recently_deleted",
                id: mutation.id,
                name: before.name,
              });
              // Clear the suppression after a window. The refetch flow
              // will have settled by then; anything older has to come
              // through as a fresh `added` post-tombstone-clear (which
              // is the explicit user intent).
              const id = mutation.id;
              setTimeout(() => {
                dispatch({ type: "clear_recently_deleted", id });
              }, 10_000);
            }
          }
          dispatch({ type: "loaded", snapshot });
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    [sessionId]
  );

  // Initial load + session-change reload.
  useEffect(() => {
    if (!sessionId) return;
    void fetchSnapshot();
    return () => {
      abortRef.current?.abort();
    };
  }, [sessionId, fetchSnapshot]);

  // Keep the lookup table aligned with the canonical entities array.
  // Done as an effect (not inline in the reducer) so the ref update
  // doesn't fight React's batching.
  useEffect(() => {
    const map = new Map<string, Entity>();
    for (const e of state.entities) map.set(e.id, e);
    priorEntityRef.current = map;
  }, [state.entities]);

  // Live-update path: optimistic merge on event, then a debounced refetch
  // so the canonical snapshot lands within ~500ms. Bursty clicks coalesce
  // into a single refetch.
  //
  // Cross-session safety: triggerExtraction is fire-and-forget and never
  // aborted on session change, so an in-flight extraction from a previous
  // session can resolve AFTER this hook has loaded a different session.
  // The emitter stamps `session_id` on every event; we filter incoming
  // events against the active `sessionId` so stale digests don't
  // contaminate the new session's codex.
  useEffect(() => {
    if (!sessionId) return;
    const off = on("world:extracted", (payload: unknown) => {
      const v = payload as {
        session_id?: string;
        added_entities?: Array<{
          id: string;
          name: string;
          kind: Entity["kind"];
        }>;
        updated_entities?: Array<{
          id: string;
          name: string;
          kind: Entity["kind"];
        }>;
      };
      if (v.session_id && v.session_id !== sessionId) return;
      dispatch({
        type: "extraction_event",
        added: v.added_entities ?? [],
        updated: v.updated_entities ?? [],
      });
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = setTimeout(() => {
        void fetchSnapshot();
      }, 350);
    });
    return () => {
      off();
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [sessionId, fetchSnapshot]);

  return { state, refresh: fetchSnapshot, mutate };
}

// Test surface — the reducer is pure; expose it so we don't need to
// jsdom-mount the hook to assert its merge invariants.
export const __test = { reducer, makeStubEntity, initialState };
