"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, RotateCcw, X } from "lucide-react";
import { useSpatialNavigation } from "@/hooks/useSpatialNavigation";
import { buildTour } from "@/lib/tour";
import { spatialNode } from "@/lib/spatial-mode";
import type { TourPlayerProps } from "./tour-player";
import { SpatialTransitionLayer } from "./SpatialTransitionLayer";

export default function SpatialTourPlayer({ nodes, continueUrl, onClose }: TourPlayerProps) {
  const steps = useMemo(() => buildTour(nodes), [nodes]);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  const { navigate, motion, pending, error, retry, cancel } = useSpatialNavigation();
  const current = steps[index]?.node;
  const next = steps[index + 1]?.node;
  const advance = useCallback(() => {
    if (!current || done) return;
    if (!next) { setDone(true); return; }
    void navigate(spatialNode(current), spatialNode(next), () => setIndex(index + 1));
  }, [current, next, done, navigate, index]);
  useEffect(() => {
    if (pending || error || done || !current) return;
    const timer = setTimeout(advance, 2600);
    return () => clearTimeout(timer);
  }, [advance, pending, error, done, current]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") { cancel(); onClose(); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [cancel, onClose]);
  if (!current) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black" role="dialog" aria-modal="true"
    aria-label={`World tour: ${steps[0]!.node.page_title}`} data-testid="tour-player" onClick={advance}>
    {/* eslint-disable-next-line @next/next/no-img-element -- saved source pixels */}
    <img src={current.image_url} alt={current.page_title} className="h-full w-full object-contain" draggable={false} />
    <SpatialTransitionLayer motion={motion} background="#000" />
    <p className="pointer-events-none absolute inset-x-4 bottom-4 z-40 text-center text-sm text-white">{current.page_title}</p>
    <div className="absolute right-3 top-3 z-40 flex items-center gap-3 text-white">
      <span>{index + 1}/{steps.length}</span>
      <button aria-label="Close tour" title="Close tour" className="flex h-11 w-11 items-center justify-center rounded bg-black/60" onClick={e => { e.stopPropagation(); cancel(); onClose(); }}><X size={20} /></button>
    </div>
    {error && <div role="alert" className="absolute inset-x-3 bottom-16 z-40 flex items-center justify-center gap-3 bg-black/80 p-3 text-white" onClick={e => e.stopPropagation()}>
      {error}<button title="Retry image" aria-label="Retry transition image" className="p-2" onClick={() => void retry()}><RotateCcw size={20} /></button>
    </div>}
    {done && <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-black/70 text-white" onClick={e => e.stopPropagation()}>
      <p className="px-6 text-center text-lg">{steps[0]!.node.page_title}</p>
      <div className="flex items-center gap-4">
        <button title="Replay tour" aria-label="Replay tour" className="flex h-11 w-11 items-center justify-center rounded border border-white/40" onClick={() => {
          void navigate(spatialNode(current), { ...spatialNode(steps[0]!.node), parentId: null }, () => { setIndex(0); setDone(false); });
        }}><RotateCcw size={20} /></button>
        <a href={continueUrl} target="_blank" rel="noopener" className="flex items-center gap-2 rounded bg-white px-4 py-2 text-black">Explore <ArrowRight size={18} /></a>
      </div>
    </div>}
  </div>;
}
