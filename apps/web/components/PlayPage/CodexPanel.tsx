"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Entity,
  EntityKind,
  WorldEntityMutation,
} from "@openflipbook/config";

import GeoEditSection from "./GeoEditSection";

interface Props {
  open: boolean;
  onClose: () => void;
  entities: Entity[];
  loading: boolean;
  error: string | null;
  // In-image hover chip overlay toggle. Optional so this component
  // remains usable in isolation (tests pass when omitted).
  chipsEnabled?: boolean;
  onToggleChips?: () => void;
  // Phase 5 — user-override CRUD. When true, each card exposes pin /
  // rename / delete affordances; when false (the default), the codex
  // stays read-only. Driven by the WORLD_OVERRIDE_ENABLED env flag the
  // server surfaces on the snapshot.
  overrideEnabled?: boolean;
  onMutate?: (
    mutation: WorldEntityMutation
  ) => Promise<{ ok: boolean; error?: string }>;
  // Geometric world (GEOMETRIC_WORLD): pass the session id to surface the
  // NL-editable map section. Omitted → the section is absent (no behaviour
  // change), so this stays additive + opt-in.
  geoEditSessionId?: string;
}

interface UndoToastState {
  id: string;
  name: string;
  expiresAt: number;
}

const KIND_ORDER: EntityKind[] = ["person", "place", "item", "creature"];
const KIND_LABEL: Record<EntityKind, string> = {
  person: "People",
  place: "Places",
  item: "Items",
  creature: "Creatures",
};
// Single uppercase letter shown in the colored kind badge. Letters chosen
// for visual distinctness without overlap.
const KIND_INITIAL: Record<EntityKind, string> = {
  person: "P",
  place: "L",
  item: "I",
  creature: "C",
};
const KIND_TINT: Record<EntityKind, string> = {
  // Slightly varied tints help skim a long codex by silhouette alone.
  // All sit comfortably on the light + dark canvas without restyling.
  person: "bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30",
  place: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30",
  item: "bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30",
  creature: "bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30",
};

type TabKind = EntityKind | "all";

/**
 * Read-only codex sidebar. Renders the current world-state registry
 * grouped by kind. Phase 5 will add user-override controls (rename,
 * merge, pin, delete) and a per-entity editor; this view is intentionally
 * inert until extraction quality is verified on real sessions.
 */
export function CodexPanel({
  open,
  onClose,
  entities,
  loading,
  error,
  chipsEnabled,
  onToggleChips,
  overrideEnabled,
  onMutate,
  geoEditSessionId,
}: Props) {
  const [tab, setTab] = useState<TabKind>("all");
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  // Phase 7b — Undo toast surfaces for ~5s after a delete. The hook keeps
  // the entity reachable via undo_delete during that window.
  const [undoToast, setUndoToast] = useState<UndoToastState | null>(null);
  // Tick the toast at 1Hz so the countdown stays visible.
  const [, setUndoTick] = useState(0);
  useEffect(() => {
    if (!undoToast) return;
    const interval = setInterval(() => setUndoTick((t) => t + 1), 250);
    const timeout = setTimeout(
      () => setUndoToast(null),
      Math.max(0, undoToast.expiresAt - Date.now())
    );
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [undoToast]);

  // Move focus into the panel on open + return it to the previously-focused
  // element on close. Skip the full focus trap for Phase 2 — keyboard users
  // can still Tab back out and `K` / Escape both close cleanly.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (open) {
      openerRef.current = document.activeElement;
      // requestAnimationFrame so the slide-in transition has begun before
      // the focus shift; otherwise some browsers skip the visible focus ring.
      const id = requestAnimationFrame(() => {
        closeButtonRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
    const prev = openerRef.current;
    if (prev && "focus" in prev && typeof (prev as HTMLElement).focus === "function") {
      (prev as HTMLElement).focus();
    }
    openerRef.current = null;
  }, [open]);

  // Group + sort once per `entities` change. Order: pinned first, then
  // most-recently-updated, so curated entries stay at the top regardless
  // of staleness.
  const grouped = useMemo(() => {
    const byKind: Record<EntityKind, Entity[]> = {
      person: [],
      place: [],
      item: [],
      creature: [],
    };
    for (const e of entities) {
      const bucket = byKind[e.kind];
      if (bucket) bucket.push(e);
    }
    const sortFn = (a: Entity, b: Entity) => {
      if (a.pinned_by_user !== b.pinned_by_user) {
        return a.pinned_by_user ? -1 : 1;
      }
      return b.updated_at.localeCompare(a.updated_at);
    };
    for (const k of KIND_ORDER) byKind[k].sort(sortFn);
    return byKind;
  }, [entities]);

  const visible = useMemo<Entity[]>(() => {
    if (tab === "all") {
      return KIND_ORDER.flatMap((k) => grouped[k]);
    }
    return grouped[tab];
  }, [tab, grouped]);

  // Tailwind's class scanner only emits classes it sees as full string
  // literals — `pointer-events-${expr}` never gets compiled. Use the two
  // literal classes via a static toggle so the closed panel can't intercept
  // clicks on the right edge of the page surface.
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="codex-panel-title"
      aria-hidden={!open}
      className={`${
        open ? "pointer-events-auto" : "pointer-events-none"
      } fixed right-0 top-0 z-[55] h-full w-full max-w-sm transform transition-transform duration-200 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="flex h-full flex-col border-l border-[var(--color-edge)] bg-[var(--color-canvas)] shadow-xl">
        <header className="flex items-center justify-between border-b border-[var(--color-edge)] px-4 py-3">
          <div>
            <h2 id="codex-panel-title" className="font-display text-base">
              Codex
            </h2>
            <p className="text-[11px] opacity-70">
              {entities.length === 0
                ? loading
                  ? "loading…"
                  : "no entities yet"
                : `${entities.length} entit${entities.length === 1 ? "y" : "ies"}`}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {onToggleChips && (
              <button
                type="button"
                onClick={onToggleChips}
                aria-pressed={Boolean(chipsEnabled)}
                title="Toggle in-image entity chips"
                className={
                  "rounded-md border px-2 py-0.5 text-[11px] transition-colors " +
                  (chipsEnabled
                    ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]"
                    : "border-[var(--color-edge)] hover:bg-[var(--color-ink)]/10")
                }
              >
                Chips {chipsEnabled ? "on" : "off"}
              </button>
            )}
            <button
              ref={closeButtonRef}
              type="button"
              className="rounded-md border border-[var(--color-edge)] px-2 py-0.5 text-xs hover:bg-[var(--color-ink)]/10"
              onClick={onClose}
              aria-label="Close codex"
            >
              Close
            </button>
          </div>
        </header>
        <nav className="flex shrink-0 gap-1 border-b border-[var(--color-edge)] px-3 py-2 text-xs">
          <TabButton
            label={`All (${entities.length})`}
            active={tab === "all"}
            onClick={() => setTab("all")}
          />
          {KIND_ORDER.map((k) => (
            <TabButton
              key={k}
              label={`${KIND_LABEL[k]} (${grouped[k].length})`}
              active={tab === k}
              onClick={() => setTab(k)}
            />
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {error && (
            <div className="rounded border border-red-400/40 bg-red-400/10 p-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
          {!error && visible.length === 0 && !loading && (
            <p className="px-1 py-6 text-center text-xs opacity-60">
              {tab === "all"
                ? "Generate a few pages with named characters or places — they'll appear here automatically."
                : `No ${KIND_LABEL[tab].toLowerCase()} cataloged yet.`}
            </p>
          )}
          <ul className="space-y-2">
            {visible.map((e) => (
              <EntityCard
                key={e.id}
                entity={e}
                editable={Boolean(overrideEnabled && onMutate)}
                onMutate={onMutate}
                onDeleted={(id, name) =>
                  setUndoToast({
                    id,
                    name,
                    expiresAt: Date.now() + 5000,
                  })
                }
              />
            ))}
          </ul>
          {overrideEnabled && geoEditSessionId && (
            <section className="mt-4 border-t border-[var(--color-edge)] pt-3">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                Map · geometry
              </h3>
              <GeoEditSection sessionId={geoEditSessionId} />
            </section>
          )}
        </div>
        {undoToast && onMutate && (
          <div className="border-t border-[var(--color-edge)] bg-[var(--color-canvas)] px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">
                Deleted{" "}
                <span className="font-medium">{undoToast.name}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  void onMutate({
                    op: "undo_delete",
                    id: undoToast.id,
                  }).then((out) => {
                    if (out.ok) setUndoToast(null);
                  });
                }}
                className="rounded-md border border-[var(--color-edge)] px-2 py-0.5 hover:bg-[var(--color-ink)]/10"
              >
                Undo (
                {Math.max(
                  0,
                  Math.ceil((undoToast.expiresAt - Date.now()) / 1000)
                )}
                s)
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rounded-md border px-2 py-1 transition-colors ${
        active
          ? "border-[var(--color-edge)] bg-[var(--color-ink)]/10"
          : "border-transparent hover:border-[var(--color-edge)]/60"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function EntityCard({
  entity,
  editable,
  onMutate,
  onDeleted,
}: {
  entity: Entity;
  editable: boolean;
  onMutate?:
    | ((mutation: WorldEntityMutation) => Promise<{ ok: boolean; error?: string }>)
    | undefined;
  onDeleted?: ((id: string, name: string) => void) | undefined;
}) {
  const resolving = !entity.appearance;
  const stateEntries = Object.entries(entity.state);
  const lowConfidence = entity.confidence > 0 && entity.confidence < 0.5;
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(entity.name);
  const [busyOp, setBusyOp] = useState<null | "pin" | "rename" | "delete">(
    null
  );
  const [opError, setOpError] = useState<string | null>(null);

  // Reset rename buffer when the canonical name changes from elsewhere
  // (e.g. extractor presence-ping updates a value, or another tab edits).
  useEffect(() => {
    setRenameValue(entity.name);
  }, [entity.name]);

  const run = async (
    op: "pin" | "rename" | "delete",
    mutation: WorldEntityMutation
  ): Promise<boolean> => {
    if (!onMutate) return false;
    setBusyOp(op);
    setOpError(null);
    const out = await onMutate(mutation);
    setBusyOp(null);
    if (!out.ok) {
      setOpError(out.error ?? "mutation failed");
      return false;
    }
    if (op === "rename") setRenameOpen(false);
    return true;
  };

  return (
    <li
      className={`group rounded-lg border border-[var(--color-edge)] bg-[var(--color-canvas)] p-3 transition-shadow hover:shadow-sm ${
        resolving ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-md font-mono text-sm ring-1 ${
            KIND_TINT[entity.kind]
          }`}
          title={KIND_LABEL[entity.kind]}
          aria-label={KIND_LABEL[entity.kind]}
        >
          {KIND_INITIAL[entity.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {renameOpen ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = renameValue.trim();
                    if (!v || v === entity.name) {
                      setRenameOpen(false);
                      return;
                    }
                    void run("rename", {
                      op: "rename",
                      id: entity.id,
                      name: v,
                    });
                  } else if (e.key === "Escape") {
                    setRenameOpen(false);
                    setRenameValue(entity.name);
                  }
                }}
                className="min-w-0 flex-1 rounded border border-[var(--color-edge)] bg-transparent px-1.5 py-0.5 text-sm outline-none focus:border-[var(--color-ink)]"
                aria-label="Rename entity"
              />
            ) : (
              <h3 className="truncate font-medium text-sm">{entity.name}</h3>
            )}
            {entity.pinned_by_user && (
              <span
                className="rounded-full bg-[var(--color-ink)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider opacity-70"
                title="Pinned by you"
              >
                pinned
              </span>
            )}
            {lowConfidence && !entity.pinned_by_user && (
              <span
                className="rounded-full border border-yellow-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-yellow-700 dark:text-yellow-300"
                title="Low confidence — may be noise"
              >
                low
              </span>
            )}
          </div>
          {entity.aliases.length > 0 && (
            <p className="mt-0.5 truncate text-[11px] opacity-60">
              aka {entity.aliases.join(", ")}
            </p>
          )}
          <p
            className={`mt-1.5 text-xs leading-snug ${
              resolving ? "italic opacity-50" : "opacity-80"
            }`}
          >
            {resolving ? "resolving…" : entity.appearance}
          </p>
        </div>
      </div>
      {entity.facts.length > 0 && (
        <ul className="mt-2 space-y-0.5 pl-11 text-[11px] opacity-75">
          {entity.facts.slice(0, 4).map((f, i) => (
            <li key={i} className="flex gap-1">
              <span className="opacity-50">·</span>
              <span>{f}</span>
            </li>
          ))}
          {entity.facts.length > 4 && (
            <li className="opacity-50">+{entity.facts.length - 4} more</li>
          )}
        </ul>
      )}
      {stateEntries.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 pl-11">
          {stateEntries.map(([k, v]) => (
            <span
              key={k}
              className="rounded bg-[var(--color-ink)]/8 px-1.5 py-0.5 font-mono text-[10px]"
            >
              {k}: {String(v)}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between pl-11 text-[10px] opacity-60">
        <span>
          {entity.appears_on_node_ids.length} appearance
          {entity.appears_on_node_ids.length === 1 ? "" : "s"}
        </span>
        {entity.confidence > 0 && (
          <span>conf {Math.round(entity.confidence * 100)}</span>
        )}
      </div>
      {editable && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-1 pl-11 text-[11px]">
          <CardActionButton
            label={entity.pinned_by_user ? "Unpin" : "Pin"}
            busy={busyOp === "pin"}
            onClick={() =>
              run("pin", {
                op: "pin",
                id: entity.id,
                pinned: !entity.pinned_by_user,
              })
            }
          />
          <CardActionButton
            label={renameOpen ? "Cancel" : "Rename"}
            busy={busyOp === "rename"}
            onClick={() => {
              if (renameOpen) {
                setRenameOpen(false);
                setRenameValue(entity.name);
              } else {
                setRenameOpen(true);
              }
            }}
          />
          <CardActionButton
            label="Delete"
            destructive
            busy={busyOp === "delete"}
            disabled={entity.pinned_by_user}
            title={
              entity.pinned_by_user
                ? "Unpin first — pinned entities cannot be deleted"
                : undefined
            }
            onClick={() => {
              if (entity.pinned_by_user) return;
              const confirmed =
                typeof window !== "undefined"
                  ? window.confirm(
                      `Delete entity "${entity.name}"? Soft-deleted — the extractor won't re-add it, and you can undo for ~5s.`
                    )
                  : true;
              if (!confirmed) return;
              void run("delete", { op: "delete", id: entity.id }).then(
                (ok) => {
                  if (ok && onDeleted) {
                    onDeleted(entity.id, entity.name);
                  }
                }
              );
            }}
          />
        </div>
      )}
      {opError && (
        <p className="mt-1 pl-11 text-[11px] text-red-700 dark:text-red-300">
          {opError}
        </p>
      )}
    </li>
  );
}

function CardActionButton({
  label,
  busy,
  destructive,
  disabled,
  title,
  onClick,
}: {
  label: string;
  busy: boolean;
  destructive?: boolean;
  disabled?: boolean;
  title?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      title={title}
      className={
        "rounded-md border px-1.5 py-0.5 transition-colors disabled:opacity-40 " +
        (destructive
          ? "border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300"
          : "border-[var(--color-edge)] hover:bg-[var(--color-ink)]/10")
      }
    >
      {busy ? "…" : label}
    </button>
  );
}
