"use client";

import type { MapCrop } from "@openflipbook/config";

import { useWorldMap } from "@/hooks/useWorldMap";
import { worldToView, type ViewBox } from "@/lib/world-overlay";

interface Props {
  sessionId: string;
}

const KIND_COLOR: Record<string, string> = {
  person: "#0ea5e9",
  place: "#10b981",
  item: "#f59e0b",
  creature: "#a855f7",
};

// The coordinate-frame inset (answers "where is the coordinate system / the
// middle / how far does it reach"). A top-down view of the WORLD coords — origin
// (0,0), +x east / +y south axes, each entity as a dot at its (x,y), the bounds
// (the current extent → expand past them), and the centre. Separate from the
// (possibly oblique) generated image, which is image-space. Self-contained.
export default function WorldMiniMap({ sessionId }: Props) {
  const { entities, bounds } = useWorldMap(sessionId);
  if (entities.length === 0) return null;

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
  const crop: MapCrop = {
    x: minX - wSpan * 0.1,
    y: minY - hSpan * 0.1,
    w: wSpan * 1.2,
    h: hSpan * 1.2,
  };

  const origin = worldToView({ x: 0, y: 0 }, crop, view);
  const centre = worldToView(
    { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    crop,
    view,
  );
  const bTL = worldToView({ x: bounds.x, y: bounds.y }, crop, view);
  const bBR = worldToView({ x: bounds.x + bounds.w, y: bounds.y + bounds.h }, crop, view);

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
        {/* centre of the world */}
        <line x1={centre.x - 5} y1={centre.y} x2={centre.x + 5} y2={centre.y} stroke="#0f766e" strokeWidth={1} />
        <line x1={centre.x} y1={centre.y - 5} x2={centre.x} y2={centre.y + 5} stroke="#0f766e" strokeWidth={1} />
        {/* entities at their world (x,y) */}
        {entities.map((e) => {
          const p = worldToView(e.pos, crop, view);
          return (
            <g key={e.id} data-testid="minimap-dot">
              <circle cx={p.x} cy={p.y} r={3} fill={KIND_COLOR[e.kind] ?? "#64748b"} />
              <text x={p.x + 4} y={p.y + 3} fontSize={7} fill="#334155">
                {e.label.length > 14 ? e.label.slice(0, 13) + "…" : e.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="px-1 text-[9px] text-stone-500">
        world coords · {entities.length} entities · bounds {Math.round(bounds.w)}×
        {Math.round(bounds.h)}
      </div>
    </div>
  );
}
