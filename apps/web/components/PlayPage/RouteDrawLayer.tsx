"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import type { MapCrop, StoredWalk, WorldEntityGeo, WorldVec2 } from "@openflipbook/config";

import { useContainRect } from "@/hooks/useContainRect";
import { renderLayoutControl } from "@/lib/layout-control";
import { ROUTE_LANE_GAP, routeFromStroke, routeShots, strokeToWorld, type Route, type RouteShot } from "@/lib/route-line";
import { toAbsoluteEntities } from "@/lib/world-geometry";

interface Props {
  /** World map geometry (any frame; resolved to absolute here). */
  entities: WorldEntityGeo[];
  /** The world rect the page's image shows. */
  frame: MapCrop;
  /** The frame the drawn route lives in (null = the root map). */
  frameParentId?: string | null;
  imgRef?: RefObject<HTMLImageElement | null>;
  /** Keep every camera aimed at this place instead of along the line. */
  lookAt?: WorldVec2 | null;
  /** Whose spend a painted walk lands on. Without it the walk cannot be paid
   *  for, so Accept stays hidden and the layer is preview-only. */
  sessionId?: string | null;
  /** The world's own art, so painted keyframes keep its medium. */
  styleRefUrl?: string | null;
  /** The page a walk is kept on -- a walk is paid for, so it outlives the tab
   *  that made it. Without it the walk still paints, it just is not kept. */
  nodeId?: string | null;
  /** A walk already painted on this page, shown instead of an empty layer. */
  savedWalk?: StoredWalk | null;
  onClose: () => void;
}

const PREVIEW_W = 320;
const PREVIEW_H = 180;
// What the model is actually given per shot. Bigger than the preview, square
// because the edit model that holds a camera was measured square.
const CONTROL_W = 768;
const CONTROL_H = 768;
// Fraction of the image a pointer must travel before the stroke gains a point.
const MIN_STEP = 0.004;

/**
 * Draw a route on the map (Phase 3). The stroke becomes world positions, the
 * camera looks along it, and checkpoints mark where a new keyframe image is
 * needed. Everything here is free: the preview is the same block render the
 * enter path already uses, so a route can be judged before any spend.
 */
export function RouteDrawLayer({ entities, frame, frameParentId = null, imgRef, lookAt = null, sessionId = null, styleRefUrl = null, nodeId = null, savedWalk = null, onClose }: Props) {
  const content = useContainRect(imgRef);
  const [stroke, setStroke] = useState<{ x: number; y: number }[]>([]);
  // A ref, not state: a burst of pointermove events inside one task would all
  // read the pre-commit state value and the stroke would come out empty.
  const drawingRef = useRef(false);
  const [selected, setSelected] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [walk, setWalk] = useState<
    { state: "idle" } | { state: "painting"; shots: number } | { state: "done"; clips: { video_url: string }[]; usd: number } | { state: "failed"; why: string }
  >(savedWalk?.clips.length ? { state: "done", clips: savedWalk.clips, usd: savedWalk.spent_usd } : { state: "idle" });

  // Walking to another page keeps this layer mounted. A stroke is drawn in the
  // image's own coordinates, so carrying it over would redraw it, silently, on
  // a map it was never drawn on.
  useEffect(() => {
    setStroke([]);
    setSelected(0);
  }, [frame.x, frame.y, frame.w, frame.h, frameParentId]);

  const absolute = useMemo(() => toAbsoluteEntities(entities, entities), [entities]);
  const routeOpts = useMemo(
    () => ({ frameParentId, laneGap: ROUTE_LANE_GAP, ...(lookAt ? { lookAt } : {}) }),
    [frameParentId, lookAt],
  );
  const route: Route | null = useMemo(() => {
    if (stroke.length < 2) return null;
    return routeFromStroke(strokeToWorld(stroke, frame), absolute, { frameParentId, ...(lookAt ? { lookAt } : {}) });
  }, [stroke, frame, absolute, frameParentId, lookAt]);


  // What each checkpoint would be a picture OF -- free, from the same block
  // render the preview draws, so a worthless camera never costs a generation.
  const shots: RouteShot[] = useMemo(
    () => (route ? routeShots(route, absolute, routeOpts) : []),
    [route, absolute, routeOpts],
  );
  const worth = useMemo(() => shots.filter((s) => s.worth), [shots]);

  const accept = useCallback(async () => {
    if (!sessionId || worth.length === 0) return;
    setWalk({ state: "painting", shots: worth.length });
    try {
      // The renderer is ours, so the control image for every camera is drawn
      // here and sent; the backend only paints and links.
      const canvas = document.createElement("canvas");
      canvas.width = CONTROL_W;
      canvas.height = CONTROL_H;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser would not give a 2d canvas");
      const payload = worth.map((s) => {
        const control = renderLayoutControl(absolute, s.observer, CONTROL_W, CONTROL_H, frameParentId, ROUTE_LANE_GAP, true);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(control.rgba), CONTROL_W, CONTROL_H), 0, 0);
        return { index: s.index, distance: s.distance, control_data_url: canvas.toDataURL("image/png"), sees: s.sees.map((v) => [v.label, v.share]) };
      });
      const res = await fetch(`/api/world/${encodeURIComponent(sessionId)}/walk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shots: payload, style_ref_url: styleRefUrl, node_id: nodeId }),
      });
      const body = (await res.json()) as { clips?: { video_url: string }[]; spent_usd?: number; error?: string };
      if (!res.ok || body.error) throw new Error(body.error || `walk failed (${res.status})`);
      setWalk({ state: "done", clips: body.clips ?? [], usd: body.spent_usd ?? 0 });
    } catch (err) {
      setWalk({ state: "failed", why: err instanceof Error ? err.message : String(err) });
    }
  }, [sessionId, worth, absolute, frameParentId, styleRefUrl, nodeId]);

  const toImage = useCallback((p: WorldVec2) => ({ x: (p.x - frame.x) / frame.w, y: (p.y - frame.y) / frame.h }), [frame]);
  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = content ? (event.clientX - box.left - content.offsetX) / content.width : (event.clientX - box.left) / box.width;
    const y = content ? (event.clientY - box.top - content.offsetY) / content.height : (event.clientY - box.top) / box.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const checkpoint = route?.checkpoints[Math.min(selected, route.checkpoints.length - 1)] ?? null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !checkpoint) return;
    // Carve as the route does, or the preview would show the camera standing
    // in a wall it was never routed through.
    const control = renderLayoutControl(absolute, checkpoint.observer, PREVIEW_W, PREVIEW_H, frameParentId, ROUTE_LANE_GAP);
    canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(control.rgba), PREVIEW_W, PREVIEW_H), 0, 0);
  }, [checkpoint, absolute, frameParentId]);

  const style = (p: { x: number; y: number }) =>
    content
      ? { left: `${content.offsetX + p.x * content.width}px`, top: `${content.offsetY + p.y * content.height}px` }
      : { left: `${p.x * 100}%`, top: `${p.y * 100}%` };

  return (
    <div className="absolute inset-0 z-20">
      <div
        className="absolute inset-0 cursor-crosshair"
        data-testid="route-canvas"
        onPointerDown={(e) => { e.preventDefault(); drawingRef.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); setSelected(0); setStroke([point(e)]); }}
        // A pointer reports far finer than the route needs, and every point
        // recomputes the whole walk: keep only moves that go somewhere.
        onPointerMove={(e) => {
          if (!drawingRef.current) return;
          const next = point(e);
          setStroke((prev) => {
            const last = prev[prev.length - 1];
            return last && Math.hypot(next.x - last.x, next.y - last.y) < MIN_STEP ? prev : [...prev, next];
          });
        }}
        onPointerUp={() => { drawingRef.current = false; }}
        onPointerLeave={() => { drawingRef.current = false; }}
      />
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full">
        {route && content && (
          <polyline
            points={route.path.map(toImage).map((p) => `${content.offsetX + p.x * content.width},${content.offsetY + p.y * content.height}`).join(" ")}
            fill="none" stroke="#e11d48" strokeWidth={2} strokeDasharray="6 4"
          />
        )}
      </svg>
      {route?.checkpoints.map((c, i) => {
        const p = toImage(c.observer.pos);
        return (
          <button
            key={`${c.distance}-${i}`}
            data-checkpoint={c.reason}
            data-blocked={c.blocked ? "1" : undefined}
            aria-label={`Checkpoint ${i + 1}, ${c.reason}, ${c.distance.toFixed(0)} units${c.blocked ? ", no clear spot" : ""}`}
            aria-pressed={i === selected}
            onClick={() => setSelected(i)}
            className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border px-1 text-[10px] leading-4 ${c.blocked ? "border-amber-600 bg-amber-500 text-white" : i === selected ? "border-rose-600 bg-rose-600 text-white" : "border-rose-600 bg-white/85 text-rose-700"}`}
            style={{ ...style(p), transform: "translate(-50%, -50%)" }}
          >
            {i + 1}
          </button>
        );
      })}
      {route?.checkpoints.map((c, i) => {
        const p = toImage(c.observer.pos);
        return (
          <span
            key={`gaze-${c.distance}-${i}`}
            aria-hidden
            className="pointer-events-none absolute block h-0 w-0 border-y-4 border-l-8 border-y-transparent border-l-rose-600"
            style={{ ...style(p), transform: `translate(4px, -50%) rotate(${(c.observer.gaze * 180) / Math.PI}deg)`, transformOrigin: "-4px 50%" }}
          />
        );
      })}
      <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center gap-3 rounded border border-[var(--color-edge)] bg-[var(--color-canvas)]/95 p-2 text-xs">
        <strong>Route</strong>
        <span data-testid="route-summary">
          {route
            ? [
                `${route.length.toFixed(0)} units`,
                `${route.checkpoints.length} keyframes`,
                checkpoint ? `#${selected + 1} ${checkpoint.reason} at ${checkpoint.distance.toFixed(0)}` : null,
                // Say it once for the whole route: a camera inside a building
                // would render from the dark, so it steps out sideways.
                route.checkpoints.some((c) => c.moved) ? `${route.checkpoints.filter((c) => c.moved).length} cameras stepped aside` : null,
                // Amber marks: the line crosses a place with no standable gap.
                route.checkpoints.some((c) => c.blocked) ? `${route.checkpoints.filter((c) => c.blocked).length} have no clear spot — redraw around the buildings` : null,
                // A camera facing open ground is not worth a generation, so
                // say how many of them would actually be painted.
                shots.length > worth.length ? `${shots.length - worth.length} see nothing — skipped` : null,
              ].filter(Boolean).join(" · ")
            : "Drag across the map to draw where the camera walks."}
        </span>
        {walk.state !== "idle" && (
          <span data-testid="route-walk-status">
            {walk.state === "painting"
              ? `Painting ${walk.shots} shots…`
              : walk.state === "done"
                ? `${walk.clips.length} clip${walk.clips.length === 1 ? "" : "s"} · $${walk.usd.toFixed(2)}`
                : walk.why}
          </span>
        )}
        <canvas ref={canvasRef} width={PREVIEW_W} height={PREVIEW_H} aria-label="Checkpoint preview" className="h-[90px] w-[160px] rounded border border-[var(--color-edge)]" />
        <span className="flex-1" />
        <button className="rounded border border-[var(--color-edge)] px-2 py-1" onClick={() => { setStroke([]); setSelected(0); setWalk({ state: "idle" }); }}>Clear</button>
        {sessionId && worth.length > 0 && walk.state !== "painting" && (
          <button
            data-testid="route-accept"
            className="rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1 text-[var(--color-canvas)]"
            onClick={() => void accept()}
          >
            {`Paint ${worth.length} shot${worth.length === 1 ? "" : "s"}`}
          </button>
        )}
        <button className="rounded border border-[var(--color-edge)] px-2 py-1" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

export default RouteDrawLayer;
