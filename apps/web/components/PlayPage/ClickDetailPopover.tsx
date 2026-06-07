"use client";

import { useState } from "react";

import type {
  MapCrop,
  ObserverPose,
  ViewLevel,
  WorldEntityGeo,
} from "@openflipbook/config";

import ObserverGazeEditor from "./ObserverGazeEditor";

export interface ClickDetailResult {
  observer: ObserverPose;
  level: ViewLevel;
  mode: "scene" | "submap";
  note: string;
}

interface Props {
  xPx: number;
  yPx: number;
  // The scene's contents (the focus place's interior), for the live preview.
  entities: WorldEntityGeo[];
  crop: MapCrop;
  initial: {
    observer: ObserverPose;
    level: ViewLevel;
    focusLabel: string;
    // The tap also qualifies as a submap (a cluster, not a single place).
    canSubmap: boolean;
    mode: "scene" | "submap";
  };
  aspect?: number;
  onConfirm: (r: ClickDetailResult) => void;
  onCancel: () => void;
}

const LEVELS: ViewLevel[] = ["map", "street", "building", "eye"];
const PITCH_STEP = 0.2;
const PITCH_LIMIT = 1.3;

// "Set your view before you enter" — anchored at the tap point. The observer/gaze
// editor is the live preview (its in-frame list comes from the same projection
// the renderer steers by); the chips are quick presets over the same pose; plain
// phrasing ("from below") maps onto the camera math. Additive + opt-in: only
// shown on a deliberate ⌘/Ctrl tap of a geo-enterable spot.
export default function ClickDetailPopover({
  xPx,
  yPx,
  entities,
  crop,
  initial,
  aspect = 16 / 9,
  onConfirm,
  onCancel,
}: Props) {
  const [observer, setObserver] = useState<ObserverPose>(initial.observer);
  const [level, setLevel] = useState<ViewLevel>(initial.level);
  const [mode, setMode] = useState<"scene" | "submap">(initial.mode);
  const [note, setNote] = useState("");

  // Move along the gaze axis (closer to / further from what you're looking at).
  const step = Math.max(crop.w, crop.h, 10) * 0.05;
  const clampPitch = (p: number) =>
    Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
  const nudgePitch = (d: number) =>
    setObserver((o) => ({ ...o, pitch: clampPitch((o.pitch ?? 0) + d) }));
  const stepAlongGaze = (sign: number) =>
    setObserver((o) => ({
      ...o,
      pos: {
        x: o.pos.x + Math.cos(o.gaze) * step * sign,
        y: o.pos.y + Math.sin(o.gaze) * step * sign,
      },
    }));

  return (
    <div
      className="absolute z-30 w-72 -translate-x-1/2 rounded-xl border border-black/15 bg-stone-50/95 p-2 shadow-xl backdrop-blur"
      style={{ left: xPx, top: yPx }}
      data-testid="click-detail-popover"
      role="dialog"
      aria-label="set your view before entering"
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-1">
        <span className="truncate text-sm font-medium text-stone-800">
          {initial.focusLabel}
        </span>
        {initial.canSubmap && (
          <button
            type="button"
            data-testid="mode-toggle"
            className="rounded border px-1.5 py-0.5 text-[11px] text-stone-600"
            onClick={() => setMode((m) => (m === "scene" ? "submap" : "scene"))}
          >
            {mode === "scene" ? "enter ▸" : "map ▾"}
          </button>
        )}
      </div>

      <div className="flex gap-1 px-1 pb-1.5" data-testid="level-pills">
        {LEVELS.map((lv) => (
          <button
            key={lv}
            type="button"
            onClick={() => setLevel(lv)}
            aria-pressed={lv === level}
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              lv === level ? "bg-sky-600 text-white" : "bg-stone-200 text-stone-600"
            }`}
          >
            {lv}
          </button>
        ))}
      </div>

      <div className="px-1">
        <ObserverGazeEditor
          entities={entities}
          crop={crop}
          observer={observer}
          aspect={aspect}
          size={200}
          onChange={setObserver}
        />
      </div>

      <div className="flex flex-wrap gap-1 px-1 pt-1.5" data-testid="detail-chips">
        <button
          type="button"
          data-testid="chip-closer"
          className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] text-stone-700"
          onClick={() => stepAlongGaze(1)}
        >
          step closer
        </button>
        <button
          type="button"
          data-testid="chip-back"
          className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] text-stone-700"
          onClick={() => stepAlongGaze(-1)}
        >
          step back
        </button>
        <button
          type="button"
          data-testid="chip-below"
          className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] text-stone-700"
          onClick={() => nudgePitch(PITCH_STEP)}
        >
          from below
        </button>
        <button
          type="button"
          data-testid="chip-above"
          className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] text-stone-700"
          onClick={() => nudgePitch(-PITCH_STEP)}
        >
          from above
        </button>
      </div>

      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="add a detail (optional)"
        data-testid="detail-note"
        className="mt-1.5 w-full rounded border px-1.5 py-1 text-xs"
      />

      <div className="mt-1.5 flex justify-end gap-1.5 px-1">
        <button
          type="button"
          onClick={onCancel}
          data-testid="detail-cancel"
          className="rounded px-2 py-1 text-xs text-stone-500 hover:text-stone-700"
        >
          cancel
        </button>
        <button
          type="button"
          data-testid="detail-confirm"
          className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white"
          onClick={() => onConfirm({ observer, level, mode, note })}
        >
          {mode === "scene" ? "enter" : "map it"}
        </button>
      </div>
    </div>
  );
}
