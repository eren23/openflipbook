"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import type { MapCrop, StoredWalk, WalkClipRow, WorldEntityGeo, WorldVec2 } from "@openflipbook/config";

import { useContainRect } from "@/hooks/useContainRect";
import { pointInBlock } from "@/lib/layout-control";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";
import { type Route } from "@/lib/route-line";
import type { ImageLedPoint } from "@/lib/image-led-walk";
import { ImageLedWalk } from "./ImageLedWalk";
import { observerToWalk, routeQuery } from "@/lib/walk-position";
import { worldEditorHref } from "@/lib/world-editor-selection";
import { resolveAbsoluteFrame, toAbsoluteEntities } from "@/lib/world-geometry";

interface Props {
  /** Optional geometry for the separate physical 3D walk link. */
  entities: WorldEntityGeo[];
  /** Image frame used for drawing and optional 3D navigation. */
  frame: MapCrop;
  /** The frame the drawn route lives in (null = the root map). */
  frameParentId?: string | null;
  imgRef?: RefObject<HTMLImageElement | null>;
  /** Keep every camera aimed at this place instead of along the line. */
  lookAt?: WorldVec2 | null;
  /** Owner of durable image-led work; without a session only drawing is shown. */
  sessionId?: string | null;
  /** The world's own art, so painted keyframes keep its medium. */
  styleRefUrl?: string | null;
  /** Saved original artwork; required for durable source-bound illustrated routes. */
  nodeId?: string | null;
  /** Historical painted clips remain playable; no automatic regeneration. */
  savedWalk?: StoredWalk | null;
  onClose: () => void;
}

const MIN_STEP = 0.004;

/** Sample the drawn source-image line, without moving points to fit proxy buildings. */
export function imageLedCheckpoints(points: readonly ImageLedPoint[], count = 6): ImageLedPoint[] {
  const clean = points.filter((p,i) => !i || Math.hypot(p.x-points[i-1]!.x,p.y-points[i-1]!.y)>1e-7);
  if (clean.length < 2) return [];
  const lengths = [0];
  for (let i=1;i<clean.length;i++) lengths.push(lengths[i-1]!+Math.hypot(clean[i]!.x-clean[i-1]!.x,clean[i]!.y-clean[i-1]!.y));
  const total = lengths.at(-1)!;
  if (total < .01) return [];
  return Array.from({length:count},(_,index)=>{
    if(index===0)return {...clean[0]!};
    if(index===count-1)return {...clean.at(-1)!};
    const distance=total*index/(count-1);
    const found=lengths.findIndex(v=>v>=distance);
    const end=found<0?clean.length-1:Math.max(1,found);
    const a=clean[end-1]!,b=clean[end]!;
    const t=(distance-lengths[end-1]!)/(lengths[end]!-lengths[end-1]!);
    return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
  });
}

/**
 * Draw an image-led route on the source artwork. Every checkpoint is retained;
 * image quality and source identity are reviewed independently of optional 3D navigation.
 */
export function RouteDrawLayer({ entities, frame, frameParentId = null, imgRef, lookAt: _lookAt = null, sessionId = null, styleRefUrl = null, nodeId = null, savedWalk = null, onClose }: Props) {
  const content = useContainRect(imgRef);
  const [stroke, setStroke] = useState<{ x: number; y: number }[]>([]);
  // A ref, not state: a burst of pointermove events inside one task would all
  // read the pre-commit state value and the stroke would come out empty.
  const drawingRef = useRef(false);
  const [selected, setSelected] = useState(0);
  // Which clip of a painted walk is playing; the player steps through them.
  const [clip, setClip] = useState(0);
  const [illustrating, setIllustrating] = useState(false);
  const [walk, setWalk] = useState<
    { state: "idle" } | { state: "painting"; shots: number } | { state: "done"; clips: Pick<WalkClipRow, "video_url" | "play_until">[]; usd: number } | { state: "failed"; why: string }
  >(savedWalk?.clips.length ? { state: "done", clips: savedWalk.clips, usd: savedWalk.spent_usd } : { state: "idle" });

  // Walking to another page keeps this layer mounted. A stroke is drawn in the
  // image's own coordinates, so carrying it over would redraw it, silently, on
  // a map it was never drawn on.
  useEffect(() => {
    setStroke([]);
    setSelected(0);
    setIllustrating(false);
    drawingRef.current = false;
  }, [frame.x, frame.y, frame.w, frame.h, frameParentId, sessionId, nodeId, styleRefUrl]);

  const absolute = useMemo(() => toAbsoluteEntities(entities, entities), [entities]);
  const points = useMemo(() => imageLedCheckpoints(stroke), [stroke]);
  const route: Route | null = useMemo(() => {
    if (!points.length) return null;
    const path = stroke.map(p=>({x:frame.x+p.x*frame.w,y:frame.y+p.y*frame.h}));
    let distance=0;
    const checkpoints=points.map((p,i)=>{
      const pos={x:frame.x+p.x*frame.w,y:frame.y+p.y*frame.h};
      if(i) distance+=Math.hypot((p.x-points[i-1]!.x)*frame.w,(p.y-points[i-1]!.y)*frame.h);
      const next=points[Math.min(i+1,points.length-1)]!,prev=points[Math.max(0,i-1)]!;
      return {observer:{pos,eye_height:1.7,gaze:Math.atan2((next.y-prev.y)*frame.h,(next.x-prev.x)*frame.w),fov:Math.PI/2,pitch:0},distance,reason:i===0?"start" as const:i===points.length-1?"end" as const:"distance" as const,moved:false,blocked:false};
    });
    return {path,checkpoints,length:distance};
  },[points,stroke,frame]);

  // Only the separate physical-walk link needs an authored scene. It cannot
  // change the normalized route or the image-led creation flow.
  const open3d = useMemo(() => {
    const start = route?.checkpoints[0]?.observer;
    if (!sessionId || !start || !placeScenesEnabled()) return null;
    const byId = new Map(entities.map((e) => [e.id, e]));
    const place = absolute.find((g) => g.scene_id && byId.get(g.parent_id ?? "")?.scene_id !== g.scene_id && pointInBlock(g, start.pos));
    const at = place && resolveAbsoluteFrame(place.id, byId);
    if (!place || !at) return null;
    // Map units per scene metre: the frame's unit times the place's own scale.
    const metres = { pos: at.pos, unit: at.unit * (place.scale ?? 1) };
    return worldEditorHref({ session_id: sessionId, place_id: place.id }, { object_id: null, floor_id: null },
      { view: "walk", route: routeQuery(route.checkpoints.map((c) => observerToWalk(c.observer, metres))) });
  }, [route, entities, absolute, sessionId]);

  const toImage = useCallback((p: WorldVec2) => ({ x: (p.x - frame.x) / frame.w, y: (p.y - frame.y) / frame.h }), [frame]);
  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = content ? (event.clientX - box.left - content.offsetX) / content.width : (event.clientX - box.left) / box.width;
    const y = content ? (event.clientY - box.top - content.offsetY) / content.height : (event.clientY - box.top) / box.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const checkpoint = route?.checkpoints[Math.min(selected, route.checkpoints.length - 1)] ?? null;
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
        onPointerCancel={() => { drawingRef.current = false; }}
        onLostPointerCapture={() => { drawingRef.current = false; }}
        onPointerLeave={() => { drawingRef.current = false; }}
      />
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox={content ? undefined : "0 0 100 100"} preserveAspectRatio="none">
        {route && (
          <polyline
            points={route.path.map(toImage).map((p) => content ? `${content.offsetX + p.x * content.width},${content.offsetY + p.y * content.height}` : `${p.x*100},${p.y*100}`).join(" ")}
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
            aria-label={`Checkpoint ${i + 1}, ${c.reason}, estimated source-image position`}
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
                `${route.checkpoints.length} checkpoints on the source map`,
                checkpoint ? `Selected #${selected + 1}` : null,
                "Positions and directions are estimated, not calibrated",
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
        {walk.state === "done" && walk.clips.length > 0 && (
          // A paid walk used to end at "2 clips · $0.69" with nothing that
          // could play it. Play its clips back to back, looping.
          <video
            key={clip}
            data-testid="route-walk-player"
            src={walk.clips[clip % walk.clips.length]!.video_url}
            autoPlay
            muted
            playsInline
            controls
            // Cut where the clip stops moving (play_until), not after its
            // frozen tail; a clip without it plays to its end.
            // Both can fire for one clip (play_until at its very end), so step
            // only from the clip this render shows: one advance per clip.
            onTimeUpdate={(e) => {
              const until = walk.clips[clip % walk.clips.length]!.play_until;
              if (until !== undefined && e.currentTarget.currentTime >= until) setClip((i) => (i === clip ? i + 1 : i));
            }}
            onEnded={() => setClip((i) => (i === clip ? i + 1 : i))}
            className="h-[180px] w-[320px] rounded border border-[var(--color-edge)] bg-black"
          />
        )}

        <span className="flex-1" />
        <button className="rounded border border-[var(--color-edge)] px-2 py-1" onClick={() => { setStroke([]); setSelected(0); setWalk({ state: "idle" }); }}>Clear</button>
        {sessionId && nodeId && <button
          type="button" data-testid="route-open-illustrated"
          className="rounded border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1 text-[var(--color-canvas)]"
          onClick={() => setIllustrating(true)}
        >{points.length ? "Create illustrated walk" : "Open saved illustrated walks"}</button>}
        {open3d && <a data-testid="route-open-3d" href={open3d} className="rounded border border-[var(--color-edge)] px-2 py-1">Walk it in 3D</a>}
        <button className="rounded border border-[var(--color-edge)] px-2 py-1" onClick={onClose}>Done</button>
      </div>
      {sessionId && nodeId && <ImageLedWalk key={`${sessionId}:${nodeId}`} sessionId={sessionId} nodeId={nodeId} mapFrame={{bounds:frame,parent_id:frameParentId}} points={points} sourceImageUrl={styleRefUrl ?? null} open={illustrating} onClose={()=>setIllustrating(false)}/>}
    </div>
  );
}

export default RouteDrawLayer;
