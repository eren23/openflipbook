"use client";

import { useMemo, type RefObject } from "react";
import type { Entity, SceneView, WorldEntityGeo } from "@openflipbook/config";

import { useContainRect } from "@/hooks/useContainRect";
import { MAP_IMAGE_FRAME } from "@/lib/geo-tap";
import {
  anchorsFromGeo,
  layoutLabels,
  type LabelInput,
} from "@/lib/map-labels";

interface Props {
  /** The page the labels overlay. */
  nodeId: string | null;
  /** Codex entities — preferred anchor source (bbox on THIS node). */
  entities: Entity[];
  /** Geo map entities — the fallback anchor source on map frames. */
  geoEntities: WorldEntityGeo[];
  /** The frame the page shows; labels render only on map frames. */
  currentView: SceneView | null;
  imgRef?: RefObject<HTMLImageElement | null>;
}

/**
 * DOM place-name labels (DOM-labels mode). With `suppress_map_labels` the
 * image renders text-free; this overlay draws the names from entity data —
 * always crisp, never garbled, and a click on a name can never be mistaken
 * for a click on a place (pointer-events pass through). Labels are only
 * ADDED for known entities; old maps with baked lettering keep it (a DOM
 * duplicate over a baked name resolves itself as label-free renders accrue).
 */
export function MapLabelOverlay({
  nodeId,
  entities,
  geoEntities,
  currentView,
  imgRef,
}: Props) {
  const content = useContainRect(imgRef);
  const placed = useMemo(() => {
    if (currentView && currentView.level !== "map") return [];
    // Preferred: codex entities localized on THIS page (bbox centres).
    const fromBBoxes: LabelInput[] = [];
    if (nodeId) {
      for (const e of entities) {
        const bbox = e.appearance_bboxes?.[nodeId];
        if (!bbox || !e.name.trim()) continue;
        fromBBoxes.push({
          id: e.id,
          name: e.name.trim(),
          xPct: bbox.x_pct + bbox.w_pct / 2,
          yPct: bbox.y_pct + bbox.h_pct / 2,
        });
      }
    }
    if (fromBBoxes.length > 0) return layoutLabels(fromBBoxes);
    // Fallback: top-level geo footprints through the seeded map frame.
    const frame = currentView?.map_crop ?? MAP_IMAGE_FRAME;
    const topLevel = geoEntities.filter((e) => (e.parent_id ?? null) === null);
    return layoutLabels(anchorsFromGeo(topLevel, frame));
  }, [nodeId, entities, geoEntities, currentView]);

  if (placed.length === 0) return null;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {placed.map((l) => {
        const left = content
          ? `${content.offsetX + l.leftPct * content.width}px`
          : `${l.leftPct * 100}%`;
        const top = content
          ? `${content.offsetY + l.topPct * content.height}px`
          : `${l.topPct * 100}%`;
        return (
          <span
            key={l.id}
            data-label-id={l.id}
            className="absolute rounded-sm border border-[var(--color-edge)] bg-[var(--color-canvas)]/85 px-1 py-px font-serif text-[11px] leading-tight tracking-wide text-[var(--color-ink)] shadow-sm backdrop-blur-[1px]"
            style={{ left, top }}
          >
            {l.name}
          </span>
        );
      })}
    </div>
  );
}
