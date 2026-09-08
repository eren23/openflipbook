"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCw } from "lucide-react";

import TourButton from "@/components/tour-button";
import { objectContainRect } from "@/lib/image-click";
import type { SpatialFrame } from "@/lib/spatial-transition";
import { SPATIAL_TRANSITIONS_ENABLED } from "@/lib/spatial-mode";
import { useSpatialNavigation } from "@/hooks/useSpatialNavigation";
import { SpatialTransitionLayer } from "./SpatialTransitionLayer";

// Read-only navigable world viewer for the /embed surface. Zero model calls:
// every navigation is a hop to an ALREADY-GENERATED node via the public
// children endpoint (the share-continue zero-generate hydration contract).
// Taps on unexplored ground get a hint instead of dead silence — the /n/
// permalink "dead taps" lesson, made an explicit UX contract at the frontier.

export interface EmbedNode {
  id: string;
  title: string;
  imageUrl: string;
  parentId?: string | null;
  imageKey?: string | undefined;
  view?: SpatialFrame["view"];
  context?: SpatialFrame["context"];
  click?: SpatialFrame["click"];
  relation?: SpatialFrame["relation"];
}

interface ChildRow {
  id: string;
  page_title: string;
  image_url: string;
  click_in_parent: { x_pct: number; y_pct: number } | null;
  image_key?: string;
  scene_view?: SpatialFrame["view"];
  transition_context?: SpatialFrame["context"];
  relation?: SpatialFrame["relation"];
}

function frame(node: EmbedNode): SpatialFrame {
  return { ...node, parentId: node.parentId ?? null, image: node.imageUrl };
}

interface EmbedViewerProps {
  sessionId: string;
  initial: EmbedNode;
  continueUrl: string;
  // The start node's render receipt, preformatted server-side (the embed
  // fetches children through the slim public route, which carries none).
  initialReceipt?: string | null;
}

export default function EmbedViewer({
  sessionId,
  initial,
  continueUrl,
  initialReceipt,
}: EmbedViewerProps) {
  const [current, setCurrent] = useState<EmbedNode>(initial);
  const spatial = useSpatialNavigation();
  const [stack, setStack] = useState<EmbedNode[]>([]);
  const [childState, setChildState] = useState<{
    nodeId: string;
    status: "ready" | "error";
    rows: ChildRow[];
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const imageRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [loadedNode, setLoadedNode] = useState<string | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [imageRetry, setImageRetry] = useState(0);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [label, setLabel] = useState<string | null>(null);
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  const hintTimer = useRef<number | null>(null);

  const measure = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect) setStage({ width: rect.width, height: rect.height });
  }, []);

  useEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => () => {
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
  }, []);

  useEffect(() => {
    // A cached SSR image can finish before hydration installs onLoad.
    if (imageRef.current?.complete && imageRef.current.naturalWidth > 0) {
      setLoadedNode(current.id);
      measure();
    }
  }, [current.id, imageRetry, measure]);

  useEffect(() => {
    let cancelled = false;
    setChildState(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/nodes/${encodeURIComponent(current.id)}/children`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error("Places unavailable");
        const json = (await res.json()) as { children: ChildRow[] };
        if (!Array.isArray(json.children)) throw new Error("Invalid places");
        if (!cancelled) setChildState({ nodeId: current.id, status: "ready", rows: json.children });
      } catch {
        if (!cancelled) setChildState({ nodeId: current.id, status: "error", rows: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current.id, retry]);

  const clearOverlays = () => {
    setLoadedNode(null);
    setFailedImage(null);
    setHint(null);
    setLabel(null);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
  };

  const enter = (c: ChildRow) => {
    const target: EmbedNode = { id: c.id, title: c.page_title, imageUrl: c.image_url, parentId: current.id, imageKey: c.image_key, view: c.scene_view, context: c.transition_context, click: c.click_in_parent, relation: c.relation };
    const commit = () => {
      setStack((s) => [...s, current]);
      setCurrent(target);
      clearOverlays();
    };
    if (SPATIAL_TRANSITIONS_ENABLED) void spatial.navigate(frame(current), frame(target), commit);
    else commit();
  };

  const back = () => {
    const prev = stack[stack.length - 1];
    if (!prev) return;
    const commit = () => {
      setCurrent(prev);
      setStack((s) => s.slice(0, -1));
      clearOverlays();
    };
    if (SPATIAL_TRANSITIONS_ENABLED) void spatial.navigate(frame(current), frame(prev), commit);
    else commit();
  };

  const status = childState?.nodeId === current.id ? childState.status : "loading";
  const content = loadedNode === current.id && imageRef.current
    ? objectContainRect(stage.width, stage.height, imageRef.current.naturalWidth, imageRef.current.naturalHeight)
    : null;

  // A tap that misses every dot = unexplored ground: show a transient hint
  // anchored at the tap instead of doing nothing.
  const onGroundClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!content || status !== "ready" || spatial.pending) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < content.offsetX || x > content.offsetX + content.width ||
        y < content.offsetY || y > content.offsetY + content.height) return;
    setHint({ x, y });
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 2600);
  };

  const dots = (status === "ready" ? childState!.rows : []).filter(
    (c): c is ChildRow & { click_in_parent: { x_pct: number; y_pct: number } } =>
      c?.click_in_parent != null && typeof c.id === "string" &&
      typeof c.page_title === "string" && typeof c.image_url === "string" &&
      [c.click_in_parent.x_pct, c.click_in_parent.y_pct].every(
        (v) => Number.isFinite(v) && v >= 0 && v <= 1
      )
  );

  const positioned = content ? dots.map((c) => ({
    ...c,
    x: content.offsetX + c.click_in_parent.x_pct * content.width,
    y: content.offsetY + c.click_in_parent.y_pct * content.height,
  })) : [];
  const activeLabel = positioned.find((c) => c.id === label);
  const overlayStyle = (point: { x: number; y: number }) => ({
    width: Math.max(0, Math.min(280, stage.width - 16)),
    left: Math.max(8, Math.min(point.x - 140, stage.width - 288)),
    top: Math.max(8, Math.min(point.y + 24, stage.height - 88)),
    maxHeight: Math.max(0, stage.height - Math.max(8, Math.min(point.y + 24, stage.height - 88)) - 8),
    overflow: "hidden" as const,
  });

  return (
    <div className="flex h-dvh flex-col bg-[#faf7f1] text-[#1c1917]">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          {stack.length > 0 && (
            <button
              type="button"
              onClick={back}
              aria-label="Back"
              title="Back"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-black/25 hover:bg-black/5"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          )}
          <span className="truncate font-medium">{current.title}</span>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <span className="opacity-60" role="status">
            {status === "loading" ? "Loading places..." : status === "error" ? "Places unavailable" : dots.length > 0
              ? `${dots.length} place${dots.length === 1 ? "" : "s"} to enter`
              : "world frontier"}
          </span>
          {status === "error" && (
            <button type="button" aria-label="Retry places" title="Retry places"
              className="flex h-11 w-11 items-center justify-center rounded border border-black/25"
              onClick={() => { setChildState(null); setRetry((n) => n + 1); }}>
              <RotateCw size={16} aria-hidden="true" />
            </button>
          )}
          <TourButton
            sessionId={sessionId}
            continueUrl={continueUrl}
            className="min-h-11 rounded border border-black/25 px-2.5 py-0.5 hover:bg-black/5 disabled:opacity-50"
          />
        </span>
      </header>

      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 cursor-pointer overflow-hidden"
        onClick={onGroundClick}
        data-testid="embed-stage"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={`${current.id}:${imageRetry}`}
          ref={imageRef}
          src={current.imageUrl}
          alt={current.title}
          className="h-full w-full object-contain"
          draggable={false}
          onLoad={(e) => {
            if (e.currentTarget !== imageRef.current) return;
            setLoadedNode(current.id);
            setFailedImage(null);
            measure();
          }}
          onError={(e) => {
            if (e.currentTarget !== imageRef.current) return;
            setLoadedNode(null);
            setFailedImage(current.id);
          }}
        />
        <SpatialTransitionLayer motion={spatial.motion} background="#faf7f1" />
        {spatial.error && <div role="alert" className="absolute inset-x-0 bottom-3 z-40 flex items-center justify-center gap-2 bg-white/90 p-2 text-sm">
          {spatial.error}
          <button type="button" aria-label="Retry transition image" title="Retry image" className="p-2" onClick={e => { e.stopPropagation(); void spatial.retry(); }}><RotateCw size={16} /></button>
        </div>}
        {failedImage === current.id && (
          <div className="absolute inset-0 flex items-center justify-center gap-2" role="alert">
            Image unavailable
            <button type="button" aria-label="Retry image" title="Retry image"
              className="flex h-11 w-11 items-center justify-center rounded border border-black/25"
              onClick={(e) => { e.stopPropagation(); setFailedImage(null); setImageRetry((n) => n + 1); }}>
              <RotateCw size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        {!spatial.pending && positioned.map((c) => (
          <button
            key={c.id}
            type="button"
            title={`Enter ${c.page_title}`}
            aria-label={`Enter ${c.page_title}`}
            onMouseEnter={() => setLabel(c.id)}
            onMouseLeave={() => setLabel(null)}
            onFocus={() => setLabel(c.id)}
            onBlur={() => setLabel(null)}
            onClick={(e) => {
              e.stopPropagation();
              enter(c);
            }}
            className="group absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded focus-visible:outline-2"
            style={{
              left: c.x,
              top: c.y,
            }}
          >
            <span className="block h-3.5 w-3.5 rounded-full border-2 border-white bg-amber-500 shadow-md transition-transform group-hover:scale-125" />
          </button>
        ))}
        {activeLabel && !hint && (
          <span role="tooltip" className="pointer-events-none absolute z-10 break-words rounded bg-black/80 px-2 py-1 text-xs text-white [overflow-wrap:anywhere]"
            style={overlayStyle(activeLabel)}>{activeLabel.page_title}</span>
        )}
        {hint && content && (
          <a
            href={continueUrl}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            className="absolute z-20 rounded bg-black/80 px-3 py-2 text-xs text-white shadow-lg [overflow-wrap:anywhere]"
            style={overlayStyle(hint)}
          >
            unexplored — continue this world on openflipbook →
          </a>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px]">
        <span className="truncate opacity-50">
          {initialReceipt && current.id === initial.id
            ? initialReceipt
            : "an openflipbook world"}
        </span>
        <a
          href={continueUrl}
          target="_blank"
          rel="noopener"
          className="flex min-h-11 items-center rounded border border-black/25 px-3 py-1 font-medium hover:bg-black/5"
        >
          Continue this world →
        </a>
      </footer>
    </div>
  );
}
