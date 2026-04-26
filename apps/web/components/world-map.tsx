"use client";

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

interface WorldMapProps {
  pages: LayoutInput[];
  activeNodeId: string | null;
  onSelect: (nodeId: string) => void;
  onClose: () => void;
}

interface Camera {
  cx: number;
  cy: number;
  zoom: number;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;

export default function WorldMap({
  pages,
  activeNodeId,
  onSelect,
  onClose,
}: WorldMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({
    w: 800,
    h: 600,
  });
  const [camera, setCamera] = useState<Camera>({ cx: 0, cy: 0, zoom: 1 });
  const [animateCamera, setAnimateCamera] = useState(true);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    cx: number;
    cy: number;
  } | null>(null);

  const { laid, connectors } = useMemo<{
    laid: LaidOutPage[];
    connectors: Connector[];
  }>(() => {
    const result = layoutPages(
      pages.filter((p): p is LayoutInput & { nodeId: string } =>
        Boolean(p.nodeId)
      )
    );
    return { laid: result.pages, connectors: result.connectors };
  }, [pages]);

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
        const cam = fitAllCamera(laid, viewport.w, viewport.h);
        setCamera(cam);
        return;
      }
      const target = laid.find((p) => p.nodeId === nodeId);
      if (!target) return;
      setCamera(fitCamera(target.rect, viewport.w, viewport.h));
    },
    [laid, viewport]
  );

  // Initial frame: fit the active page (or everything if there's no active).
  useEffect(() => {
    if (viewport.w === 0 || viewport.h === 0) return;
    if (laid.length === 0) return;
    focusOn(activeNodeId, false);
    // Re-run only when laid set changes meaningfully — the active swap
    // doesn't trigger an auto-pan so the user can browse freely.
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
        // World point under cursor before zoom.
        const wx = cam.cx + (px - viewport.w / 2) / cam.zoom;
        const wy = cam.cy + (py - viewport.h / 2) / cam.zoom;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const nextZoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        // Re-anchor so the cursor stays over the same world point.
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
      // Only begin pan on background — tile clicks are handled separately.
      const tgt = e.target as HTMLElement;
      if (tgt.dataset.tile === "1") return;
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      setAnimateCamera(false);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        cx: camera.cx,
        cy: camera.cy,
      };
    },
    [camera]
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setCamera((cam) => ({
      cx: drag.cx - (e.clientX - drag.startX) / cam.zoom,
      cy: drag.cy - (e.clientY - drag.startY) / cam.zoom,
      zoom: cam.zoom,
    }));
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    },
    []
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[78dvh] min-h-[480px] w-full overflow-hidden rounded-2xl border border-[var(--color-ink)]/20 bg-[var(--color-canvas)] shadow-lg"
      style={{
        backgroundImage:
          "radial-gradient(rgba(15,15,15,0.10) 1px, transparent 1px)",
        backgroundSize: "22px 22px",
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
            ? "transform 350ms cubic-bezier(0.22, 0.61, 0.36, 1)"
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
                id="ofb-arrow"
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
              // Perpendicular offset for a gentle S-curve.
              const px = -dy / len;
              const py = dx / len;
              const bend = len * 0.18;
              const c1x = c.from.x + dx * 0.33 + px * bend;
              const c1y = c.from.y + dy * 0.33 + py * bend;
              const c2x = c.from.x + dx * 0.67 - px * bend;
              const c2y = c.from.y + dy * 0.67 - py * bend;
              return (
                <g key={c.fromNodeId + "->" + c.toNodeId}>
                  <path
                    d={`M ${c.from.x} ${c.from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${c.to.x} ${c.to.y}`}
                    fill="none"
                    stroke="rgba(15,15,15,0.55)"
                    strokeWidth={8}
                    strokeLinecap="round"
                    strokeDasharray="2 22"
                    markerEnd="url(#ofb-arrow)"
                  />
                  <circle
                    cx={c.from.x}
                    cy={c.from.y}
                    r={14}
                    fill="rgba(239,68,68,0.85)"
                    stroke="white"
                    strokeWidth={4}
                  />
                </g>
              );
            })}
          </svg>
        )}

        {laid.map((p) => (
          <button
            key={p.nodeId}
            data-tile="1"
            onClick={() => onSelect(p.nodeId)}
            className="absolute block cursor-pointer overflow-hidden rounded-md border bg-white shadow-sm transition-shadow hover:shadow-lg"
            style={{
              left: p.rect.x,
              top: p.rect.y,
              width: p.rect.w,
              height: p.rect.h,
              borderColor:
                p.nodeId === activeNodeId
                  ? "rgba(239, 68, 68, 0.95)"
                  : "rgba(0,0,0,0.2)",
              borderWidth: p.nodeId === activeNodeId ? 6 : 2,
            }}
            title={p.title}
          >
            {p.imageDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.imageDataUrl}
                alt={p.title}
                draggable={false}
                className="block h-full w-full select-none object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs opacity-50">
                (loading)
              </div>
            )}
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between px-3 py-2 text-[11px] opacity-70">
        <span>scroll to zoom · drag to pan · click a tile to open</span>
        <span>{laid.length} pages</span>
      </div>

      <div className="absolute right-3 top-3 flex gap-2">
        <button
          type="button"
          onClick={() => focusOn(null, true)}
          className="pointer-events-auto rounded-full border border-[var(--color-ink)]/30 bg-white/80 px-3 py-1 text-xs hover:bg-white"
        >
          fit all
        </button>
        <button
          type="button"
          onClick={() => focusOn(activeNodeId, true)}
          disabled={!activeNodeId}
          className="pointer-events-auto rounded-full border border-[var(--color-ink)]/30 bg-white/80 px-3 py-1 text-xs hover:bg-white disabled:opacity-40"
        >
          recenter
        </button>
        <button
          type="button"
          onClick={onClose}
          className="pointer-events-auto rounded-full border border-[var(--color-ink)]/30 bg-white/80 px-3 py-1 text-xs hover:bg-white"
        >
          close map
        </button>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
