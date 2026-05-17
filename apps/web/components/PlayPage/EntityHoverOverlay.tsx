"use client";

import { useMemo, useState } from "react";
import type { Entity, EntityBBox } from "@openflipbook/config";

interface Props {
  /** Stable id of the page the chips are layered on. */
  nodeId: string | null;
  /** All entities the codex knows about. */
  entities: Entity[];
  /** Visibility toggle. The play page persists a setting. */
  enabled: boolean;
  /** Fired when the user clicks a chip — focus codex entry / open panel. */
  onSelect?: (entityId: string) => void;
}

interface VisibleChip {
  entity: Entity;
  bbox: EntityBBox;
}

/**
 * In-image hover-chip overlay. Renders a small marker dot at each
 * entity's bbox centre on the current page; hovering / long-pressing
 * the dot reveals a peek card with name + state + last-seen. Click
 * jumps to the codex entry.
 *
 * Positioned absolutely inside the page <figure>; the parent gives us
 * the bounding box so percentages map 1:1 to pixels.
 *
 * Pre-Phase-4 entities have no bbox in `appearance_bboxes` for the
 * current node and are silently skipped — the codex still lists them,
 * just without an on-image affordance.
 */
export function EntityHoverOverlay({
  nodeId,
  entities,
  enabled,
  onSelect,
}: Props) {
  // Resolve once per (nodeId, entities) change. The expensive bit is the
  // bbox lookup; everything else is cheap object pruning.
  const visible = useMemo<VisibleChip[]>(() => {
    if (!enabled || !nodeId) return [];
    const out: VisibleChip[] = [];
    for (const e of entities) {
      const bbox = e.appearance_bboxes?.[nodeId];
      if (!bbox) continue;
      // Stale stubs from extraction_event have empty appearance — skip
      // until the canonical refetch fills them in so we don't show
      // chips for placeholders.
      if (!e.appearance && !e.facts.length) continue;
      out.push({ entity: e, bbox });
    }
    return out;
  }, [enabled, nodeId, entities]);

  if (!enabled || visible.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Page entities"
      className="pointer-events-none absolute inset-0 z-10"
    >
      {visible.map(({ entity, bbox }) => (
        <ChipMarker
          key={entity.id}
          entity={entity}
          bbox={bbox}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function ChipMarker({
  entity,
  bbox,
  onSelect,
}: {
  entity: Entity;
  bbox: EntityBBox;
  onSelect?: ((entityId: string) => void) | undefined;
}) {
  const [hover, setHover] = useState(false);
  // Centre the marker on the bbox; the peek card is anchored just below.
  const cx = (bbox.x_pct + bbox.w_pct / 2) * 100;
  const cy = (bbox.y_pct + bbox.h_pct / 2) * 100;
  // When the marker is in the lower half of the image, flip the peek
  // card above so it doesn't extend past the bottom edge.
  const placeAbove = cy > 65;
  const stateEntries = Object.entries(entity.state).slice(0, 3);
  return (
    <div
      className="pointer-events-auto absolute"
      style={{
        left: `${cx}%`,
        top: `${cy}%`,
        transform: "translate(-50%, -50%)",
      }}
    >
      <button
        type="button"
        aria-label={`Entity: ${entity.name}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={() => onSelect?.(entity.id)}
        className={
          "block h-3 w-3 rounded-full border border-white/80 shadow transition-transform " +
          (hover
            ? "scale-125 bg-white"
            : "bg-white/70 hover:bg-white hover:scale-110")
        }
      />
      {hover && (
        <div
          className={
            "pointer-events-none absolute left-1/2 z-10 w-48 -translate-x-1/2 rounded-md border border-white/15 bg-black/80 px-2 py-1.5 text-[11px] text-white shadow-lg backdrop-blur-sm " +
            (placeAbove ? "bottom-full mb-2" : "top-full mt-2")
          }
        >
          <div className="font-medium leading-tight">{entity.name}</div>
          {entity.kind && (
            <div className="text-[10px] uppercase tracking-wider opacity-60">
              {entity.kind}
            </div>
          )}
          {entity.appearance && (
            <p className="mt-1 line-clamp-2 opacity-85">{entity.appearance}</p>
          )}
          {stateEntries.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {stateEntries.map(([k, v]) => (
                <span
                  key={k}
                  className="rounded bg-white/10 px-1 font-mono text-[10px]"
                >
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
