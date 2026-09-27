"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Eraser, MousePointer2, Paintbrush, Trash2, Undo2 } from "lucide-react";
import { brushPixels, brushStrokes, type IllustrationBrushStroke } from "@/lib/illustration-brush";
import type { SavedPlaceView } from "@/lib/place-view";
import s from "./world-editor.module.css";
import IllustrationSurface from "./illustration-surface";

export default function IllustrationRegionPicker({ sessionId, view, imageUrl, selected, onChange, disabled, onReady, strokes, onBrushChange, surfaceTarget, showObjects = true, imageLabel = "Region edit proposal", onImageLoad, onImageError }: {
  sessionId: string; view: SavedPlaceView; imageUrl: string; selected: string[];
  onChange(ids: string[]): void; disabled: boolean; onReady(ready: boolean): void;
  strokes?: IllustrationBrushStroke[] | undefined; onBrushChange?(strokes: IllustrationBrushStroke[] | undefined): void;
  surfaceTarget?: HTMLElement | null | undefined; showObjects?: boolean; imageLabel?: string;
  onImageLoad?(): void; onImageError?(): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), [pixels, setPixels] = useState<Uint8ClampedArray | null>(null), [error, setError] = useState("");
  const [tool, setTool] = useState<"select" | "paint" | "erase">("select"), [radius, setRadius] = useState(12), [painted, setPainted] = useState(0);
  const gesture = useRef<{ pointer: number; previous: IllustrationBrushStroke[]; stroke: IllustrationBrushStroke } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); let stopped = false;
    setPixels(null); setError(""); onReady(false);
    void (async () => {
      const response = await fetch(`/api/world/${encodeURIComponent(sessionId)}/views/${encodeURIComponent(view.id)}/objects`, { cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error("Saved object mask unavailable");
      const bitmap = await createImageBitmap(await response.blob());
      try {
        if (stopped) return;
        if (bitmap.width !== view.width || bitmap.height !== view.height) throw new Error("Saved object mask dimensions differ");
        const buffer = document.createElement("canvas"); buffer.width = view.width; buffer.height = view.height;
        const context = buffer.getContext("2d"); if (!context) throw new Error("Object selection canvas unavailable");
        context.drawImage(bitmap, 0, 0); setPixels(context.getImageData(0, 0, view.width, view.height).data);
      } finally { bitmap.close(); }
    })().catch(e => { if (!stopped) setError((e as Error).message); });
    return () => { stopped = true; abort.abort(); };
  }, [sessionId, view.id, view.width, view.height, onReady]);
  useEffect(() => {
    const context = canvas.current?.getContext("2d"); if (!context || !pixels) return;
    const output = context.createImageData(view.width, view.height);
    const colors = new Set(view.objects.filter(o => selected.includes(o.object_id)).map(o => o.rgb[0] * 65536 + o.rgb[1] * 256 + o.rgb[2]));
    const brush = strokes ? brushPixels(strokes, view.width, view.height) : null;
    let count = 0; const seen = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      const color = pixels[i]! * 65536 + pixels[i + 1]! * 256 + pixels[i + 2]!;
      if (pixels[i + 3] === 255 && colors.has(color) && (!brush || brush[i / 4])) {
        output.data[i] = 30; output.data[i + 1] = 210; output.data[i + 2] = 195; output.data[i + 3] = 130;
        count++; seen.add(color);
      }
    }
    context.putImageData(output, 0, 0); setPainted(count);
    onReady(!error && (!brush || count > 0 && seen.size === selected.length));
  }, [pixels, selected, view, strokes, onReady, error, surfaceTarget]);
  const toggle = (id: string) => { if (!disabled) onChange(selected.includes(id) ? selected.filter(v => v !== id) : [...selected, id].slice(0, 128)); };
  const point = (event: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(view.width - 1, Math.floor((event.clientX - rect.left) / rect.width * view.width))), Math.max(0, Math.min(view.height - 1, Math.floor((event.clientY - rect.top) / rect.height * view.height)))];
  };
  const publish = (next: IllustrationBrushStroke[]) => {
    try { brushStrokes(next, view.width, view.height); setError(""); onBrushChange?.(next); return true; }
    catch (e) { setError((e as Error).message); return false; }
  };
  const finish = (event: React.PointerEvent<HTMLCanvasElement>, cancel: boolean) => {
    if (gesture.current?.pointer !== event.pointerId) return;
    const previous = gesture.current.previous; gesture.current = null;
    if (cancel) publish(previous);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className={s.regionPicker} role="group" aria-label="Registered object selection">
    {onBrushChange && <>
      <div className={s.regionTools} role="toolbar" aria-label="Region selection tools">
        <button title="Select whole objects" aria-label="Select whole objects" aria-pressed={tool === "select"} disabled={disabled} onClick={() => { setTool("select"); setError(""); onBrushChange(undefined); }}><MousePointer2 size={16}/></button>
        <button title="Brush region" aria-label="Brush region" aria-pressed={tool === "paint"} disabled={disabled} onClick={() => { setTool("paint"); if (!strokes) onBrushChange([]); }}><Paintbrush size={16}/></button>
        <button title="Erase region" aria-label="Erase region" aria-pressed={tool === "erase"} disabled={disabled || !strokes} onClick={() => setTool("erase")}><Eraser size={16}/></button>
        <button title="Undo region stroke" aria-label="Undo region stroke" disabled={disabled || !strokes?.length} onClick={() => publish(strokes!.slice(0, -1))}><Undo2 size={16}/></button>
        <button title="Clear region strokes" aria-label="Clear region strokes" disabled={disabled || !strokes?.length} onClick={() => publish([])}><Trash2 size={16}/></button>
      </div>
      {tool !== "select" && <label>Brush radius ({radius} px)<input aria-label="Brush radius" type="range" min={1} max={64} step={1} value={radius} disabled={disabled} onChange={e => setRadius(Number(e.target.value))}/></label>}
    </>}
    <IllustrationSurface target={surfaceTarget} width={view.width} height={view.height}>
      <Image unoptimized src={imageUrl} alt={imageLabel} fill sizes={surfaceTarget ? "100vw" : "320px"} onLoad={onImageLoad} onError={onImageError}/>
      <canvas ref={canvas} width={view.width} height={view.height} aria-label="Object selection overlay" style={{ touchAction: tool === "select" ? "manipulation" : "none" }} onPointerDown={event => {
        if (!pixels || disabled) return;
        const rect = event.currentTarget.getBoundingClientRect(), x = Math.floor((event.clientX - rect.left) / rect.width * view.width), y = Math.floor((event.clientY - rect.top) / rect.height * view.height);
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) return;
        const i = (y * view.width + x) * 4;
        const object = pixels[i + 3] === 255 && view.objects.find(o => o.rgb[0] === pixels[i] && o.rgb[1] === pixels[i + 1] && o.rgb[2] === pixels[i + 2]);
        if (tool === "select") { if (object) toggle(object.object_id); return; }
        if (gesture.current || event.button !== 0) return;
        event.preventDefault();
        if (!selected.length && object) onChange([object.object_id]);
        const stroke: IllustrationBrushStroke = { operation: tool, radius, points: [point(event)] }, previous = strokes ?? [];
        if (publish([...previous, stroke])) { gesture.current = { pointer: event.pointerId, previous, stroke }; event.currentTarget.setPointerCapture?.(event.pointerId); }
      }} onPointerMove={event => {
        const active = gesture.current; if (!active || active.pointer !== event.pointerId || disabled) return;
        const next = point(event), last = active.stroke.points.at(-1)!;
        if (next[0] === last[0] && next[1] === last[1]) return;
        const stroke = { ...active.stroke, points: [...active.stroke.points, next] };
        if (publish([...active.previous, stroke])) active.stroke = stroke;
      }} onPointerUp={event => finish(event, false)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}/>
    </IllustrationSurface>
    {strokes && <output aria-label="Painted region pixels">{painted.toLocaleString()} selected pixels</output>}
    {showObjects && <fieldset className={s.regionObjects} disabled={disabled || !pixels}><legend>Selected objects ({selected.length})</legend>
      {view.objects.map(o => <label key={o.object_id} className={s.checkbox}><input type="checkbox" checked={selected.includes(o.object_id)} onChange={() => toggle(o.object_id)}/><span>{o.object_id}</span></label>)}
    </fieldset>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
