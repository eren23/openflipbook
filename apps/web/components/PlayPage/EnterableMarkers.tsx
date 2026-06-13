"use client";

import { useMemo, type RefObject } from "react";
import type { MapCrop, SceneView, WorldEntityGeo } from "@openflipbook/config";

import { useContainRect } from "@/hooks/useContainRect";
import { MAP_IMAGE_FRAME } from "@/lib/geo-tap";
import { cropEntities } from "@/lib/world-geometry";

interface Props {
  /** The geo world map's entities (all of them; this component scopes). */
  entities: WorldEntityGeo[];
  /** The frame the page shows. Markers render only on map frames
   *  (null = the top-level map; a submap carries its crop). */
  currentView: SceneView | null;
  /** The rendered <img>; markers track the object-contain content rect. */
  imgRef?: RefObject<HTMLImageElement | null>;
  /** Flag-gated (NEXT_PUBLIC_ENTER_COACH): a louder, ping-animated ring. The
   *  default subtle ring is lost next to the bold DOM labels — the blind UX
   *  bench saw labels but not the rings the coach copy points at. */
  prominent?: boolean;
}

/**
 * Idle-state enter affordance (W3). A soft pulsing ring on every ENTERABLE
 * place of the current map frame, so "tap = enter a place" is discoverable
 * before the first click — previously only revealed by ⌘-tap. Pure
 * decoration: pointer events pass through to the image's own tap handler,
 * and world OFF never mounts it (the parent gates), so classic exploration
 * is pixel-identical.
 */
export function EnterableMarkers({
  entities,
  currentView,
  imgRef,
  prominent = false,
}: Props) {
  const content = useContainRect(imgRef);
  const markers = useMemo(() => {
    // Inside an entered place the frame is a scene, not the map — no rings.
    if (currentView && currentView.level !== "map") return [];
    const frame: MapCrop = currentView?.map_crop ?? MAP_IMAGE_FRAME;
    // Top-level places only: nested children live in their parent's frame
    // and would project to the wrong spot on the city map.
    const places = entities.filter(
      (e) => e.kind === "place" && (e.parent_id ?? null) === null,
    );
    return cropEntities(places, frame).map((e) => ({
      id: e.id,
      label: e.label,
      xPct: (e.pos.x - frame.x) / frame.w,
      yPct: (e.pos.y - frame.y) / frame.h,
    }));
  }, [entities, currentView]);

  if (markers.length === 0) return null;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {markers.map((m) => {
        const left = content
          ? `${content.offsetX + m.xPct * content.width}px`
          : `${m.xPct * 100}%`;
        const top = content
          ? `${content.offsetY + m.yPct * content.height}px`
          : `${m.yPct * 100}%`;
        return (
          <span
            key={m.id}
            data-entity-id={m.id}
            data-prominent={prominent ? "1" : undefined}
            title={m.label}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left, top }}
          >
            {prominent ? (
              // Louder affordance: an expanding ping ring + a solid glowing
              // core so "tap a glowing place" has something that visibly glows.
              <span className="relative flex h-7 w-7">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/50" />
                <span className="relative inline-flex h-7 w-7 rounded-full border-2 border-emerald-500 bg-emerald-400/20 shadow-[0_0_14px_rgba(16,185,129,0.8)]" />
              </span>
            ) : (
              <span className="block h-5 w-5 animate-pulse rounded-full border-2 border-emerald-600/60 shadow-[0_0_8px_rgba(16,185,129,0.45)]" />
            )}
          </span>
        );
      })}
    </div>
  );
}
