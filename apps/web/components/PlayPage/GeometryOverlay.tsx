"use client";

import type { CSSProperties, RefObject } from "react";

import type { Entity } from "@openflipbook/config";

import { useContainRect } from "@/hooks/useContainRect";

interface Props {
  entities: Pick<Entity, "id" | "name" | "kind" | "appearance_bboxes">[];
  nodeId: string;
  /** The rendered <img>; lets the overlay track the object-contain content rect
   *  so boxes land on the image, not the letterboxed wrapper (codex #8). */
  imgRef?: RefObject<HTMLImageElement | null>;
}

const KIND_COLOR: Record<string, string> = {
  person: "#0ea5e9",
  place: "#10b981",
  item: "#f59e0b",
  creature: "#a855f7",
};

// Debug/inspection layer (FIX 0): draws the localized coordinate box for each
// entity on this node, straight over the image. Boxes are 0..1 normalized
// (top-left) in image space, so positioning by % overlays the image exactly.
// Toggled by the caller; purely presentational + pointer-transparent.
export default function GeometryOverlay({ entities, nodeId, imgRef }: Props) {
  const content = useContainRect(imgRef);
  const boxes = entities.flatMap((e) => {
    const bb = e.appearance_bboxes?.[nodeId];
    return bb ? [{ e, bb }] : [];
  });
  // Map an image-space (0..1) bbox onto the element. With a measured content
  // rect we land on the letterboxed image (px); otherwise fall back to
  // wrapper-relative % (exact when the image fills the box, e.g. 16:9-in-16:9).
  const place = (bb: {
    x_pct: number;
    y_pct: number;
    w_pct: number;
    h_pct: number;
  }): CSSProperties =>
    content
      ? {
          left: `${content.offsetX + bb.x_pct * content.width}px`,
          top: `${content.offsetY + bb.y_pct * content.height}px`,
          width: `${bb.w_pct * content.width}px`,
          height: `${bb.h_pct * content.height}px`,
        }
      : {
          left: `${bb.x_pct * 100}%`,
          top: `${bb.y_pct * 100}%`,
          width: `${bb.w_pct * 100}%`,
          height: `${bb.h_pct * 100}%`,
        };
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="geometry-overlay">
      {boxes.map(({ e, bb }) => {
        const color = KIND_COLOR[e.kind] ?? "#64748b";
        return (
          <div
            key={e.id}
            data-testid="geo-box"
            className="absolute border-2"
            style={{
              ...place(bb),
              borderColor: color,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
            }}
          >
            <span
              className="absolute left-0 top-0 -translate-y-full whitespace-nowrap px-1 text-[10px] font-medium text-white"
              style={{ backgroundColor: color }}
            >
              {e.name}
            </span>
          </div>
        );
      })}
      {boxes.length === 0 && (
        <div className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
          no localized geometry for this page
        </div>
      )}
    </div>
  );
}
