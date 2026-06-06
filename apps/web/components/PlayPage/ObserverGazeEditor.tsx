"use client";

import { useRef, useState, type PointerEvent as RPointerEvent } from "react";

import type { MapCrop, ObserverPose, WorldEntityGeo } from "@openflipbook/config";

import { projectScene } from "@/lib/world-geometry";
import {
  gazeConePoints,
  viewToWorld,
  worldToView,
  type Point,
  type ViewBox,
} from "@/lib/world-overlay";

interface Props {
  entities: WorldEntityGeo[];
  crop: MapCrop;
  observer: ObserverPose;
  aspect?: number;
  size?: number;
  onChange?: (observer: ObserverPose) => void;
}

type DragKind = "pos" | "gaze" | null;

// A top-down editor for an observer pose: drag the camera dot to move it, drag
// the gaze handle to re-aim. The in-frame list below recomputes live from the
// SAME projection engine the renderer uses, so what you see listed is what the
// scene would contain. Rendered only behind GEOMETRIC_WORLD; additive + gated.
export default function ObserverGazeEditor({
  entities,
  crop,
  observer,
  aspect = 16 / 9,
  size = 280,
  onChange,
}: Props) {
  const view: ViewBox = { w: size, h: size, pad: 18 };
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragKind>(null);

  const cone = gazeConePoints(observer, crop, view, size * 0.3);
  const inFrame = projectScene(entities, observer, aspect);
  const inFrameIds = new Set(inFrame.map((p) => p.id));

  const localPoint = (e: RPointerEvent): Point => {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (!drag || !onChange) return;
    const p = localPoint(e);
    if (drag === "pos") {
      onChange({ ...observer, pos: viewToWorld(p, crop, view) });
    } else {
      onChange({ ...observer, gaze: Math.atan2(p.y - cone.apex.y, p.x - cone.apex.x) });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <svg
        ref={svgRef}
        width={size}
        height={size}
        className="touch-none select-none rounded-lg bg-stone-50"
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        role="img"
        aria-label="observer and gaze editor"
      >
        <polygon
          points={`${cone.apex.x},${cone.apex.y} ${cone.left.x},${cone.left.y} ${cone.right.x},${cone.right.y}`}
          fill="rgba(59,130,246,0.15)"
          stroke="rgba(59,130,246,0.5)"
        />
        {entities.map((ent) => {
          const s = worldToView(ent.pos, crop, view);
          return (
            <circle
              key={ent.id}
              cx={s.x}
              cy={s.y}
              r={5}
              fill={inFrameIds.has(ent.id) ? "#b45309" : "#cbd5e1"}
            />
          );
        })}
        <circle
          cx={cone.center.x}
          cy={cone.center.y}
          r={7}
          fill="#3b82f6"
          className="cursor-grab"
          onPointerDown={() => setDrag("gaze")}
          data-testid="gaze-handle"
        />
        <circle
          cx={cone.apex.x}
          cy={cone.apex.y}
          r={9}
          fill="#1d4ed8"
          className="cursor-grab"
          onPointerDown={() => setDrag("pos")}
          data-testid="observer-handle"
        />
      </svg>
      <ul className="space-y-0.5 text-xs text-stone-600" data-testid="in-frame">
        {inFrame.length === 0 ? (
          <li className="italic text-stone-400">nothing in frame — drag the camera</li>
        ) : (
          inFrame.map((p) => (
            <li key={p.id}>
              <span className="font-medium">{p.label || p.id}</span>{" "}
              <span className="text-stone-400">
                {p.size} · {p.h_pos} {p.v_pos}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
