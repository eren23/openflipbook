"use client";

import type { Entity } from "@openflipbook/config";

interface Props {
  entities: Pick<Entity, "id" | "name" | "kind" | "appearance_bboxes">[];
  nodeId: string;
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
export default function GeometryOverlay({ entities, nodeId }: Props) {
  const boxes = entities.flatMap((e) => {
    const bb = e.appearance_bboxes?.[nodeId];
    return bb ? [{ e, bb }] : [];
  });
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
              left: `${bb.x_pct * 100}%`,
              top: `${bb.y_pct * 100}%`,
              width: `${bb.w_pct * 100}%`,
              height: `${bb.h_pct * 100}%`,
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
