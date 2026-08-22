"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { buildTour, type TourNode, type TourStep } from "@/lib/tour";

// Tour mode: the world plays itself. Each step HOLDS on a page with a slow
// Ken Burns drift, then leaves the way the explorer did — a camera DIVE into
// the exact tap point before crossfading to the child, or a plain cut on
// branch jumps. Pure CSS transforms over already-generated images: zero
// model calls, works inside the embed iframe. Click = skip ahead, Esc = out.

const HOLD_MS = 2600;
const DIVE_MS = 950;
const CUT_MS = 500;

interface TourPlayerProps {
  nodes: TourNode[];
  continueUrl: string;
  onClose: () => void;
}

export default function TourPlayer({ nodes, continueUrl, onClose }: TourPlayerProps) {
  const steps = useMemo(() => buildTour(nodes), [nodes]);
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<"hold" | "exit" | "done">("hold");
  const timer = useRef<number | null>(null);
  const reduced = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  const step: TourStep | undefined = steps[i];

  useEffect(() => {
    if (!step) return;
    if (timer.current) window.clearTimeout(timer.current);
    if (phase === "hold") {
      timer.current = window.setTimeout(
        () => setPhase(step.exit === "end" ? "done" : "exit"),
        HOLD_MS
      );
    } else if (phase === "exit") {
      const ms = reduced ? CUT_MS : step.exit === "dive" ? DIVE_MS : CUT_MS;
      timer.current = window.setTimeout(() => {
        setI((cur) => cur + 1);
        setPhase("hold");
      }, ms);
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [phase, i, step, reduced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!step) return null;
  const next = steps[i + 1];

  const skip = () => {
    if (phase === "done") return;
    if (next) {
      setI(i + 1);
      setPhase("hold");
    } else {
      setPhase("done");
    }
  };

  // The current frame's transform. Hold = gentle drift toward the exit
  // target; dive = hard zoom anchored on the tap point. Reduced motion
  // keeps every frame static and rides opacity alone.
  const origin = step.target
    ? `${step.target.x_pct * 100}% ${step.target.y_pct * 100}%`
    : "50% 50%";
  const transform = reduced
    ? "none"
    : phase === "exit" && step.exit === "dive"
      ? "scale(2.4)"
      : phase === "hold"
        ? "scale(1.06)"
        : "scale(1)";
  const transitionMs =
    phase === "hold" ? HOLD_MS + 200 : step.exit === "dive" ? DIVE_MS : CUT_MS;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      onClick={skip}
      data-testid="tour-player"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={step.node.id}
        src={step.node.image_url}
        alt={step.node.page_title}
        className="h-full w-full object-contain"
        style={{
          transform,
          transformOrigin: origin,
          transition: `transform ${transitionMs}ms ease-in, opacity ${CUT_MS}ms`,
          opacity: phase === "exit" && step.exit !== "dive" ? 0 : 1,
        }}
        draggable={false}
      />
      {next && (
        // Preload the next frame under the current one.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={next.node.image_url}
          alt=""
          className="pointer-events-none absolute h-0 w-0 opacity-0"
          draggable={false}
        />
      )}
      <div className="pointer-events-none absolute bottom-4 left-0 right-0 text-center text-sm text-white/90">
        {step.node.page_title}
      </div>
      <div className="absolute right-3 top-3 flex items-center gap-2">
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
          {i + 1}/{steps.length}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="rounded-full bg-white/15 px-2.5 py-0.5 text-sm text-white hover:bg-white/25"
          aria-label="Close tour"
        >
          ×
        </button>
      </div>
      {phase === "done" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="px-6 text-center text-lg text-white">
            {steps[0]!.node.page_title}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setI(0);
                setPhase("hold");
              }}
              className="rounded-full border border-white/40 px-4 py-1.5 text-sm text-white hover:bg-white/10"
            >
              ↻ replay
            </button>
            <a
              href={continueUrl}
              target="_blank"
              rel="noopener"
              className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black"
            >
              explore it yourself →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
