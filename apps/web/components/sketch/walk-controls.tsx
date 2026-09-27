"use client";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw, RotateCw } from "lucide-react";
import { walkTapSeconds, type WalkInput } from "@/lib/walk-input";
import s from "./world-editor.module.css";

export default function WalkControls({ input }: { input: WalkInput }) {
  return <div className={s.walkControls}>{([
    ["a", ArrowLeft, "Strafe left"], ["w", ArrowUp, "Walk forward"], ["s", ArrowDown, "Walk backward"],
    ["d", ArrowRight, "Strafe right"], ["ArrowLeft", RotateCcw, "Turn left"], ["ArrowRight", RotateCw, "Turn right"],
  ] as const).map(([key, Icon, label]) => <button key={key} type="button" title={label} aria-label={label}
    onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); input.hold(key, `pointer:${e.pointerId}`); }}
    onPointerUp={e => input.release(`pointer:${e.pointerId}`, walkTapSeconds(key))}
    onPointerCancel={e => input.release(`pointer:${e.pointerId}`)}
    onLostPointerCapture={e => input.release(`pointer:${e.pointerId}`)}
    onClick={e => { if (e.detail === 0) input.tap(key); }}><Icon size={19}/></button>)}</div>;
}
