"use client";

import type { MapCrop } from "@openflipbook/config";

import { useWorldMap } from "@/hooks/useWorldMap";
import {
  childrenOf,
  cropEntities,
  localBounds,
  toAbsoluteEntities,
} from "@/lib/world-geometry";
import { worldToView, type ViewBox } from "@/lib/world-overlay";

interface Props {
  sessionId: string;
  // When set, the inset scopes to the place you're INSIDE: its child-frame
  // entities in their LOCAL coordinates, not the whole session's world frame.
  focusId?: string | null;
  focusLabel?: string | null;
  // A submap crop (tap-empty → cropped region): scope the inset to it, in world
  // coords. Mutually exclusive with focusId in practice (scene vs submap).
  crop?: MapCrop | null;
  // The current page IS an interior arrival (scene_view.place_form ===
  // "interior", INTERIOR_ENTERS): you're standing inside — "no interior
  // mapped yet" would be a lie, so the chip drops the complaint.
  interiorHere?: boolean;
}

const KIND_COLOR: Record<string, string> = {
  person: "#0ea5e9",
  place: "#10b981",
  item: "#f59e0b",
  creature: "#a855f7",
};

// The coordinate-frame inset (answers "where is the coordinate system / the
// middle / how far does it reach"). A top-down view: origin (0,0), +x east /
// +y south, each entity a dot at its (x,y), the bounds, the centre. Separate
// from the (possibly oblique) generated image, which is image-space.
// When `focusId` is set, it scopes to that place's interior in LOCAL coords
// rather than the whole world — otherwise a sub-part shows the city's frame.
export default function WorldMiniMap({
  sessionId,
  focusId,
  focusLabel,
  crop,
  interiorHere,
}: Props) {
  const { entities: worldEntities, bounds: worldBounds } = useWorldMap(sessionId);

  // The place's name: caller override, else the focus entity's own label.
  const resolvedLabel =
    focusLabel ?? worldEntities.find((e) => e.id === focusId)?.label ?? "here";
  const kids = focusId ? childrenOf(worldEntities, focusId) : null;

  // Inside a place whose interior isn't mapped yet → say so, rather than
  // silently showing the whole city (the bug: the map's coords on a sub-part).
  if (focusId && worldEntities.length > 0 && (!kids || kids.length === 0)) {
    return (
      <div
        className="pointer-events-none absolute right-2 top-12 rounded-lg border border-black/20 bg-stone-50/95 px-2 py-1.5 text-[10px] text-stone-500 shadow-lg"
        data-testid="minimap-empty"
      >
        inside {resolvedLabel}
        {interiorHere ? "" : " · no interior mapped yet"}
      </div>
    );
  }

  const local = !!(kids && kids.length > 0);
  const submap = !local && !!crop;
  // World views plot ABSOLUTE coords: resolve nested entities (post-ascend
  // reparents, seeded interiors) once up front — pos + unit-scaled footprint
  // — so the crop filter, the label budget, and the dots all agree. A local
  // (inside-a-place) view IS the place's frame, so children plot raw.
  const resolved = local
    ? kids!
    : toAbsoluteEntities(worldEntities, worldEntities);
  const entities = local
    ? kids!
    : submap
      ? cropEntities(resolved, crop!)
      : resolved;
  if (entities.length === 0) return null;
  const bounds = local ? localBounds(kids!) : submap ? crop! : worldBounds;
  // Parent lookups (tether lines) read from the full resolved set so a
  // cropped-out parent still anchors its child's tether.
  const byId = new Map(resolved.map((e) => [e.id, e]));
  // Label budget: tiny SVG text collides fast, so only the biggest
  // footprints get names — every entity keeps its dot. (A4 cheap fix.)
  const labelIds = new Set(
    [...entities]
      .sort(
        (a, b) => b.footprint.w * b.footprint.d - a.footprint.w * a.footprint.d,
      )
      .slice(0, 6)
      .map((e) => e.id),
  );

  const W = 208;
  const H = 148;
  const view: ViewBox = { w: W, h: H, pad: 16 };
  // Frame the bounds (+10% margin) so dots aren't on the edge; always include 0,0.
  const minX = Math.min(bounds.x, 0);
  const minY = Math.min(bounds.y, 0);
  const maxX = Math.max(bounds.x + bounds.w, 0);
  const maxY = Math.max(bounds.y + bounds.h, 0);
  const wSpan = Math.max(maxX - minX, 1);
  const hSpan = Math.max(maxY - minY, 1);
  const viewWindow: MapCrop = {
    x: minX - wSpan * 0.1,
    y: minY - hSpan * 0.1,
    w: wSpan * 1.2,
    h: hSpan * 1.2,
  };

  const origin = worldToView({ x: 0, y: 0 }, viewWindow, view);
  const centre = worldToView(
    { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    viewWindow,
    view,
  );
  const bTL = worldToView({ x: bounds.x, y: bounds.y }, viewWindow, view);
  const bBR = worldToView({ x: bounds.x + bounds.w, y: bounds.y + bounds.h }, viewWindow, view);

  return (
    <div
      className="pointer-events-none absolute right-2 top-12 rounded-lg border border-black/20 bg-stone-50/95 p-1 shadow-lg"
      data-testid="world-minimap"
    >
      <svg width={W} height={H}>
        {/* bounds = the current extent */}
        <rect
          x={Math.min(bTL.x, bBR.x)}
          y={Math.min(bTL.y, bBR.y)}
          width={Math.abs(bBR.x - bTL.x)}
          height={Math.abs(bBR.y - bTL.y)}
          fill="none"
          stroke="#94a3b8"
          strokeDasharray="3 3"
        />
        {/* origin + axes: +x east (right), +y south (down) */}
        <line x1={origin.x} y1={origin.y} x2={origin.x + 22} y2={origin.y} stroke="#dc2626" strokeWidth={1.5} />
        <line x1={origin.x} y1={origin.y} x2={origin.x} y2={origin.y + 22} stroke="#2563eb" strokeWidth={1.5} />
        <text x={origin.x + 24} y={origin.y + 3} fontSize={8} fill="#dc2626">+x E</text>
        <text x={origin.x + 2} y={origin.y + 30} fontSize={8} fill="#2563eb">+y S</text>
        <circle cx={origin.x} cy={origin.y} r={2.5} fill="#111827" />
        <text x={origin.x + 3} y={origin.y - 3} fontSize={8} fill="#111827">0,0</text>
        {/* centre of the frame */}
        <line x1={centre.x - 5} y1={centre.y} x2={centre.x + 5} y2={centre.y} stroke="#0f766e" strokeWidth={1} />
        <line x1={centre.x} y1={centre.y - 5} x2={centre.x} y2={centre.y + 5} stroke="#0f766e" strokeWidth={1} />
        {/* entities at their (x,y) — already resolved to the view's frame
            above (absolute for world views, local inside a place). Nested
            entities keep a tether line to their parent. */}
        {entities.map((e) => {
          const p = worldToView(e.pos, viewWindow, view);
          const nested = !local && !!(e.parent_id && byId.has(e.parent_id));
          const parentPos = nested
            ? worldToView(byId.get(e.parent_id!)?.pos ?? e.pos, viewWindow, view)
            : null;
          return (
            <g key={e.id} data-testid="minimap-dot">
              {parentPos && (
                <line
                  x1={parentPos.x}
                  y1={parentPos.y}
                  x2={p.x}
                  y2={p.y}
                  stroke="#cbd5e1"
                  strokeWidth={0.5}
                />
              )}
              <circle
                cx={p.x}
                cy={p.y}
                r={nested ? 2 : 3}
                fill={KIND_COLOR[e.kind] ?? "#64748b"}
              />
              {!nested && labelIds.has(e.id) && (
                <text x={p.x + 4} y={p.y + 3} fontSize={7} fill="#334155">
                  {e.label.length > 14 ? e.label.slice(0, 13) + "…" : e.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="px-1 text-[9px] text-stone-500">
        {local
          ? `inside ${resolvedLabel} · ${entities.length} parts · local coords`
          : submap
            ? `submap · ${entities.length} here · ${Math.round(crop!.w)}×${Math.round(crop!.h)}`
            : `world coords · ${entities.length} entities · bounds ${Math.round(bounds.w)}×${Math.round(bounds.h)}`}
      </div>
    </div>
  );
}
