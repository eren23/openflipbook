"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fitAllCamera,
  fitCamera,
  layoutPages,
  type Connector,
  type LaidOutPage,
  type LayoutInput,
} from "@/lib/world-layout";
import HeatmapOverlay from "@/components/heatmap-overlay";

export interface AtlasNode {
  id: string;
  parentId: string | null;
  title: string;
  query: string;
  imageUrl: string;
  clickInParent: { xPct: number; yPct: number } | null;
  createdAt: string;
  imageModel: string;
  promptAuthorModel: string;
}

interface AtlasViewProps {
  sessionId: string;
  nodes: AtlasNode[];
  latestNodeId: string | null;
  rootTitle: string;
}

interface Camera {
  cx: number;
  cy: number;
  zoom: number;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;
const STAGGER_MS = 70;
// Cap the counter-scale on overlays. Without this, at zoom=MIN_ZOOM (0.02)
// the factor reaches 50, blowing a 640px popup up to ~32000 CSS px and
// erupting outside the viewport.
const MAX_COUNTER_SCALE = 8;

function counterScale(zoom: number): number {
  return Math.min(1 / Math.max(zoom, 0.0001), MAX_COUNTER_SCALE);
}

export default function AtlasView({
  sessionId,
  nodes,
  latestNodeId,
  rootTitle,
}: AtlasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 1280, h: 720 });
  const [camera, setCamera] = useState<Camera>({ cx: 0, cy: 0, zoom: 1 });
  const [animateCamera, setAnimateCamera] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(latestNodeId);
  const [heatmapId, setHeatmapId] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    cx: number;
    cy: number;
    moved: boolean;
  } | null>(null);
  // Browsers fire `click` after `pointerup`. We null `dragRef` on pointerup
  // (so the cursor flips back to grab), so the click handler can't read the
  // moved-flag off the live ref. Stash it here for the trailing click.
  const recentDragMovedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const layoutInputs = useMemo<LayoutInput[]>(
    () =>
      nodes.map((n) => ({
        nodeId: n.id,
        parentId: n.parentId,
        imageDataUrl: n.imageUrl,
        title: n.title,
        ...(n.clickInParent ? { clickInParent: n.clickInParent } : {}),
      })),
    [nodes]
  );

  const { laid, connectors, depthById, byId } = useMemo<{
    laid: LaidOutPage[];
    connectors: Connector[];
    depthById: Map<string, number>;
    byId: Map<string, AtlasNode>;
  }>(() => {
    const result = layoutPages(layoutInputs);
    const m = new Map<string, AtlasNode>();
    for (const n of nodes) m.set(n.id, n);
    // BFS depth from each root, used for stagger order on reveal.
    const depth = new Map<string, number>();
    const queue: { id: string; d: number }[] = [];
    for (const n of nodes) if (n.parentId == null) queue.push({ id: n.id, d: 0 });
    const childrenOf = new Map<string, string[]>();
    for (const n of nodes) {
      if (!n.parentId) continue;
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n.id);
      childrenOf.set(n.parentId, arr);
    }
    while (queue.length) {
      const { id, d } = queue.shift()!;
      if (depth.has(id)) continue;
      depth.set(id, d);
      for (const child of childrenOf.get(id) ?? []) {
        queue.push({ id: child, d: d + 1 });
      }
    }
    // Orphans (parent_id pointed outside this session) — give them their own
    // depth bucket starting after the deepest known one.
    let maxD = 0;
    for (const v of depth.values()) if (v > maxD) maxD = v;
    let orphanD = maxD + 1;
    for (const n of nodes) {
      if (!depth.has(n.id)) depth.set(n.id, orphanD++);
    }
    return {
      laid: result.pages,
      connectors: result.connectors,
      depthById: depth,
      byId: m,
    };
  }, [layoutInputs, nodes]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const focusOn = useCallback(
    (nodeId: string | null, animate: boolean = true) => {
      setAnimateCamera(animate);
      if (!nodeId) {
        setCamera(fitAllCamera(laid, viewport.w, viewport.h));
        return;
      }
      const target = laid.find((p) => p.nodeId === nodeId);
      if (!target) return;
      setCamera(fitCamera(target.rect, viewport.w, viewport.h));
    },
    [laid, viewport]
  );

  // First frame: fit everything (or focus the latest if it's deep enough).
  useEffect(() => {
    if (viewport.w === 0 || viewport.h === 0) return;
    if (laid.length === 0) return;
    focusOn(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laid.length, viewport.w, viewport.h]);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      setAnimateCamera(false);
      setCamera((cam) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return cam;
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const wx = cam.cx + (px - viewport.w / 2) / cam.zoom;
        const wy = cam.cy + (py - viewport.h / 2) / cam.zoom;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const nextZoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const nextCx = wx - (px - viewport.w / 2) / nextZoom;
        const nextCy = wy - (py - viewport.h / 2) / nextZoom;
        return { cx: nextCx, cy: nextCy, zoom: nextZoom };
      });
    },
    [viewport]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest('[data-tile="1"]')) return;
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      setAnimateCamera(false);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        cx: camera.cx,
        cy: camera.cy,
        moved: false,
      };
    },
    [camera]
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4
    ) {
      drag.moved = true;
    }
    setCamera((cam) => ({
      cx: drag.cx - (e.clientX - drag.startX) / cam.zoom,
      cy: drag.cy - (e.clientY - drag.startY) / cam.zoom,
      zoom: cam.zoom,
    }));
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId);
      recentDragMovedRef.current = dragRef.current?.moved ?? false;
      dragRef.current = null;
    },
    []
  );

  // Minimap dims.
  const MM_W = 200;
  const MM_H = 130;
  const minimapBox = useMemo(() => {
    if (laid.length === 0)
      return { x: 0, y: 0, w: 1, h: 1, scale: 1, cam: null as DOMRect | null };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of laid) {
      minX = Math.min(minX, p.rect.x);
      minY = Math.min(minY, p.rect.y);
      maxX = Math.max(maxX, p.rect.x + p.rect.w);
      maxY = Math.max(maxY, p.rect.y + p.rect.h);
    }
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const scale = Math.min(MM_W / w, MM_H / h);
    return { x: minX, y: minY, w, h, scale, cam: null };
  }, [laid]);

  const onMinimapClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const wx = minimapBox.x + px / minimapBox.scale;
      const wy = minimapBox.y + py / minimapBox.scale;
      setAnimateCamera(true);
      setCamera((cam) => ({ cx: wx, cy: wy, zoom: cam.zoom }));
    },
    [minimapBox]
  );

  const total = nodes.length;

  return (
    <main className="relative flex h-dvh w-full flex-col bg-[var(--color-canvas)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-ink)]/15 px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="rounded-full border border-[var(--color-ink)]/30 px-2 py-0.5 text-xs hover:bg-[var(--color-ink)]/5"
          >
            ← home
          </Link>
          <h1 className="font-display text-base font-bold">
            atlas — <span className="opacity-70">{rootTitle}</span>
          </h1>
          <span className="text-xs opacity-60">{total} pages</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => focusOn(null, true)}
            className="rounded-full border border-[var(--color-ink)]/30 px-3 py-1 hover:bg-[var(--color-ink)]/5"
          >
            fit all
          </button>
          {focusedId && (
            <button
              type="button"
              onClick={() => focusOn(focusedId, true)}
              className="rounded-full border border-[var(--color-ink)]/30 px-3 py-1 hover:bg-[var(--color-ink)]/5"
            >
              recenter focus
            </button>
          )}
          <Link
            href={`/play?continue=${encodeURIComponent(sessionId)}`}
            className="rounded-full bg-[var(--color-ink)] px-3 py-1 text-[var(--color-canvas)]"
          >
            continue session
          </Link>
        </div>
      </header>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden"
        style={{
          backgroundImage:
            "radial-gradient(rgba(15,15,15,0.10) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          cursor: dragRef.current ? "grabbing" : "grab",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div
          className="absolute left-1/2 top-1/2 origin-center"
          style={{
            transform: `translate(${-camera.cx * camera.zoom}px, ${
              -camera.cy * camera.zoom
            }px) scale(${camera.zoom})`,
            transformOrigin: "0 0",
            transition: animateCamera
              ? "transform 420ms cubic-bezier(0.22, 0.61, 0.36, 1)"
              : "none",
            willChange: "transform",
          }}
        >
          {connectors.length > 0 && (
            <svg
              className="pointer-events-none absolute"
              style={{
                left: -100000,
                top: -100000,
                width: 200000,
                height: 200000,
                overflow: "visible",
              }}
              viewBox="-100000 -100000 200000 200000"
            >
              <defs>
                <marker
                  id="ofb-atlas-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="rgba(15,15,15,0.55)" />
                </marker>
              </defs>
              {connectors.map((c) => {
                const dx = c.to.x - c.from.x;
                const dy = c.to.y - c.from.y;
                const len = Math.hypot(dx, dy) || 1;
                const px = -dy / len;
                const py = dx / len;
                const bend = len * 0.18;
                const c1x = c.from.x + dx * 0.33 + px * bend;
                const c1y = c.from.y + dy * 0.33 + py * bend;
                const c2x = c.from.x + dx * 0.67 - px * bend;
                const c2y = c.from.y + dy * 0.67 - py * bend;
                const childDepth = depthById.get(c.toNodeId) ?? 0;
                const delay = reduced ? 0 : childDepth * STAGGER_MS;
                return (
                  <g key={c.fromNodeId + "->" + c.toNodeId}>
                    <path
                      d={`M ${c.from.x} ${c.from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${c.to.x} ${c.to.y}`}
                      fill="none"
                      stroke="rgba(15,15,15,0.55)"
                      strokeWidth={8}
                      strokeLinecap="round"
                      strokeDasharray="2 22"
                      markerEnd="url(#ofb-atlas-arrow)"
                      className={reduced ? undefined : "ofb-edge-draw"}
                      style={
                        reduced
                          ? undefined
                          : { animationDelay: `${delay}ms` }
                      }
                    />
                    <circle
                      cx={c.from.x}
                      cy={c.from.y}
                      r={14}
                      fill="rgba(239,68,68,0.85)"
                      stroke="white"
                      strokeWidth={4}
                      className={reduced ? undefined : "ofb-edge-draw"}
                      style={
                        reduced
                          ? undefined
                          : { animationDelay: `${delay}ms` }
                      }
                    />
                  </g>
                );
              })}
            </svg>
          )}

          {laid.map((p) => {
            const node = byId.get(p.nodeId);
            const isFocused = p.nodeId === focusedId;
            const showHeatmap = p.nodeId === heatmapId;
            const depth = depthById.get(p.nodeId) ?? 0;
            const delay = reduced ? 0 : depth * STAGGER_MS;
            return (
              <div
                key={p.nodeId}
                data-tile="1"
                className={
                  "absolute overflow-visible " +
                  (reduced ? "" : "ofb-tile-in")
                }
                style={{
                  left: p.rect.x,
                  top: p.rect.y,
                  width: p.rect.w,
                  height: p.rect.h,
                  ...(reduced
                    ? {}
                    : {
                        animationDelay: `${delay}ms`,
                      }),
                }}
                onMouseEnter={() => setHoveredId(p.nodeId)}
                onMouseLeave={() =>
                  setHoveredId((cur) => (cur === p.nodeId ? null : cur))
                }
              >
                <button
                  type="button"
                  onClick={(e) => {
                    if (recentDragMovedRef.current) {
                      recentDragMovedRef.current = false;
                      return;
                    }
                    if (e.shiftKey) {
                      focusOn(p.nodeId, true);
                      setFocusedId(p.nodeId);
                      return;
                    }
                    setFocusedId(p.nodeId);
                    window.location.href = `/n/${encodeURIComponent(p.nodeId)}`;
                  }}
                  className="block h-full w-full cursor-pointer overflow-hidden rounded-md border bg-white shadow-sm transition-shadow hover:shadow-2xl"
                  style={{
                    borderColor: isFocused
                      ? "rgba(239, 68, 68, 0.95)"
                      : "rgba(0,0,0,0.2)",
                    borderWidth: isFocused ? 6 : 2,
                  }}
                  title={`${p.title} — click to open · shift-click to focus`}
                >
                  {p.imageDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.imageDataUrl}
                      alt={p.title}
                      draggable={false}
                      className="block h-full w-full select-none object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs opacity-50">
                      (loading)
                    </div>
                  )}
                </button>

                {showHeatmap && <HeatmapOverlay parentId={p.nodeId} />}

                {hoveredId === p.nodeId && node && (
                  <div
                    className="pointer-events-none absolute -top-4 left-0 z-20 w-[640px] -translate-y-full rounded-xl border border-black/30 bg-white p-3 text-black shadow-2xl"
                    style={{
                      // Counter-scale so the popup stays readable regardless of zoom.
                      transform: `scale(${counterScale(camera.zoom)})`,
                      transformOrigin: "0 100%",
                    }}
                  >
                    <div className="text-xs uppercase tracking-wide opacity-50">
                      depth {depth}
                      {p.parentId
                        ? ` · child of ${truncate(byId.get(p.parentId)?.title ?? "?", 40)}`
                        : " · root"}
                    </div>
                    <div className="mt-1 font-display text-base font-bold leading-tight">
                      {node.title}
                    </div>
                    <div className="mt-1 text-xs opacity-70">
                      query: {truncate(node.query, 80)}
                    </div>
                    <div className="mt-1 text-[10px] opacity-50">
                      {fmt(node.createdAt)} · {node.imageModel}
                    </div>
                  </div>
                )}

                <div
                  className="pointer-events-auto absolute -bottom-1 right-1 flex translate-y-full gap-1 pt-2 text-[10px]"
                  style={{
                    transform: `translateY(100%) scale(${counterScale(camera.zoom)})`,
                    transformOrigin: "100% 0",
                  }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHeatmapId((cur) => (cur === p.nodeId ? null : p.nodeId));
                    }}
                    className="rounded-full border border-black/30 bg-white px-2 py-0.5 text-black shadow hover:bg-black hover:text-white"
                    title="Show where children were tapped"
                  >
                    {showHeatmap ? "hide taps" : "show taps"}
                  </button>
                  <Link
                    href={`/n/${encodeURIComponent(p.nodeId)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded-full border border-black/30 bg-white px-2 py-0.5 text-black shadow hover:bg-black hover:text-white"
                  >
                    open
                  </Link>
                </div>
              </div>
            );
          })}
        </div>

        {/* Minimap. */}
        <div className="pointer-events-auto absolute bottom-3 right-3 rounded-lg border border-black/30 bg-white/85 p-1 shadow-lg backdrop-blur">
          <div
            className="relative cursor-pointer"
            style={{ width: MM_W, height: MM_H }}
            onClick={onMinimapClick}
            title="click to pan"
          >
            {laid.map((p) => (
              <div
                key={"mm-" + p.nodeId}
                className="absolute"
                style={{
                  left: (p.rect.x - minimapBox.x) * minimapBox.scale,
                  top: (p.rect.y - minimapBox.y) * minimapBox.scale,
                  width: p.rect.w * minimapBox.scale,
                  height: p.rect.h * minimapBox.scale,
                  background:
                    p.nodeId === focusedId
                      ? "rgba(239,68,68,0.85)"
                      : "rgba(15,15,15,0.5)",
                  borderRadius: 2,
                }}
              />
            ))}
            {/* Camera viewport rectangle. */}
            {viewport.w > 0 && (
              <div
                className="pointer-events-none absolute border-2 border-red-500"
                style={{
                  left:
                    (camera.cx - viewport.w / 2 / camera.zoom - minimapBox.x) *
                    minimapBox.scale,
                  top:
                    (camera.cy - viewport.h / 2 / camera.zoom - minimapBox.y) *
                    minimapBox.scale,
                  width: (viewport.w / camera.zoom) * minimapBox.scale,
                  height: (viewport.h / camera.zoom) * minimapBox.scale,
                }}
              />
            )}
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center text-[11px] opacity-60">
          scroll to zoom · drag to pan · click a tile to open · shift-click to focus
        </div>
      </div>
    </main>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}
