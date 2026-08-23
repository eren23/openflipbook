import type { MapCrop, WorldEntityGeo } from "@openflipbook/config";

// The map you EARNED: the session's world map with fog over everything the
// explorer hasn't reached. Pure server-renderable SVG — each known entity
// burns a soft hole in the fog around its footprint; the frontier (the
// bounds margin and the gaps between places) stays clouded. No interaction,
// no client JS: this is the artifact half of the atlas, not a control.

interface FogMapProps {
  entities: WorldEntityGeo[];
  bounds: MapCrop;
  className?: string;
}

export default function FogMap({ entities, bounds, className }: FogMapProps) {
  if (entities.length === 0) return null;
  // Pad the viewBox so unexplored margin is VISIBLE around the known world —
  // fog with nothing beyond it reads as a border, not a frontier.
  const pad = Math.max(bounds.w, bounds.h, 1) * 0.18;
  const vb = {
    x: bounds.x - pad,
    y: bounds.y - pad,
    w: bounds.w + pad * 2,
    h: bounds.h + pad * 2,
  };
  return (
    <svg
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      className={className ?? "h-auto w-full"}
      role="img"
      aria-label={`Explored world map: ${entities.length} known places, fog beyond`}
    >
      <defs>
        <radialGradient id="fog-hole">
          <stop offset="0%" stopColor="black" />
          <stop offset="70%" stopColor="black" stopOpacity="0.85" />
          <stop offset="100%" stopColor="black" stopOpacity="0" />
        </radialGradient>
        <mask id="fog-mask">
          {/* White = fog stays; each known place burns a soft hole. */}
          <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill="white" />
          {entities.map((e) => (
            <circle
              key={e.id}
              cx={e.pos.x}
              cy={e.pos.y}
              r={Math.max(e.footprint.w, e.footprint.d) * 1.6}
              fill="url(#fog-hole)"
            />
          ))}
        </mask>
      </defs>
      {/* Parchment ground */}
      <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill="#efe7d6" />
      {/* Known places: footprint plates + a dot */}
      {entities.map((e) => (
        <g key={e.id}>
          <rect
            x={e.pos.x - e.footprint.w / 2}
            y={e.pos.y - e.footprint.d / 2}
            width={e.footprint.w}
            height={e.footprint.d}
            rx={Math.min(e.footprint.w, e.footprint.d) * 0.2}
            fill="#b9a77f"
            opacity={0.55}
          />
          <circle cx={e.pos.x} cy={e.pos.y} r={vb.w * 0.006} fill="#4a3f2a" />
        </g>
      ))}
      {/* The fog itself, masked open over the explored places. */}
      <rect
        x={vb.x}
        y={vb.y}
        width={vb.w}
        height={vb.h}
        fill="#2b2416"
        mask="url(#fog-mask)"
        opacity={0.62}
      />
    </svg>
  );
}
