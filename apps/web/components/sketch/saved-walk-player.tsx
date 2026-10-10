"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import s from "./world-editor.module.css";

type Direction = "forward" | "back";
interface Props { src: string; width: number; height: number; disabled?: boolean; mapHref?: string; onError?: () => void }
const keys = new Map<string, Direction>([["w", "forward"], ["arrowup", "forward"], ["s", "back"], ["arrowdown", "back"]]);
const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']"));

/** Free control of existing video bytes. This component cannot create another step. */
export default function SavedWalkPlayer({ src, width, height, disabled = false, mapHref, onError }: Props) {
  const region = useRef<HTMLElement | null>(null), videoRef = useRef<HTMLVideoElement | null>(null);
  const holds = useRef(new Map<string, Direction>()), raf = useRef(0), epoch = useRef(0), alive = useRef(true);
  const [motion, setMotion] = useState<Direction | null>(null), [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0), [duration, setDuration] = useState(0), [error, setError] = useState("");
  const decoded = duration > 0 && Number.isFinite(duration);
  const stop = useCallback(() => { ++epoch.current; holds.current.clear(); cancelAnimationFrame(raf.current); raf.current = 0; videoRef.current?.pause(); setMotion(null); setPlaying(false); }, []);
  const progress = useCallback(() => { const video = videoRef.current; if (!video) return; const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0; setDuration(end); setTime(Math.max(0, Math.min(end, video.currentTime || 0))); }, []);
  useLayoutEffect(() => { stop(); setTime(0); setDuration(0); setError(""); }, [src, stop]);
  useEffect(() => { alive.current = true; const media = videoRef.current, held = holds.current, frame = raf, token = epoch; return () => { alive.current = false; ++token.current; held.clear(); cancelAnimationFrame(frame.current); media?.pause(); }; }, [src]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);

  const update = useCallback(() => {
    cancelAnimationFrame(raf.current); raf.current = 0; const token = ++epoch.current, video = videoRef.current;
    const directions = new Set(holds.current.values());
    if (!video || disabled || directions.size !== 1 || !(video.duration > 0) || !Number.isFinite(video.duration)) { video?.pause(); setMotion(null); setPlaying(false); return; }
    const direction = [...directions][0]!; setError("");
    if (direction === "forward") {
      if (video.ended || video.currentTime >= video.duration) { stop(); return; }
      setMotion("forward");
      void video.play().then(() => {
        const forwardHeld = holds.current.size > 0 && [...holds.current.values()].every(value => value === "forward");
        if (!alive.current || videoRef.current !== video || token !== epoch.current && !forwardHeld) video.pause();
      }).catch(() => { if (alive.current && token === epoch.current) { stop(); setError("Press Forward again to play the saved clip."); } });
      return;
    }
    video.pause(); setPlaying(false);
    if (video.currentTime <= 0) { stop(); return; }
    setMotion("back"); let previous: number | null = null;
    const reverse = (now: number) => {
      if (!alive.current || token !== epoch.current || videoRef.current !== video) return;
      if (previous === null) previous = now;
      // Wait for a seek to decode before asking for another frame. Never
      // accumulate a large jump when the browser is slow or the tab changes.
      if (!video.seeking) {
        const elapsed = Math.min(.1, Math.max(0, (now - previous) / 1000)); previous = now;
        const next = video.currentTime - elapsed;
        video.currentTime = next < 1e-9 ? 0 : next; progress();
      }
      if (video.currentTime <= 0) stop(); else raf.current = requestAnimationFrame(reverse);
    };
    raf.current = requestAnimationFrame(reverse);
  }, [disabled, progress, stop]);
  const hold = useCallback((source: string, direction: Direction) => { if (disabled || !decoded || holds.current.has(source)) return; holds.current.set(source, direction); update(); }, [decoded, disabled, update]);
  const release = useCallback((source: string) => { if (!holds.current.delete(source)) return; update(); }, [update]);
  useEffect(() => {
    const up = (event: globalThis.KeyboardEvent) => { if (keys.has(event.key.toLowerCase())) release(`key:${event.key.toLowerCase()}`); if (event.key === "Enter") release("button:enter"); };
    const pointer = (event: globalThis.PointerEvent) => release(`pointer:${event.pointerId}`);
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener("keyup", up); window.addEventListener("pointerup", pointer); window.addEventListener("pointercancel", pointer); window.addEventListener("blur", stop); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("keyup", up); window.removeEventListener("pointerup", pointer); window.removeEventListener("pointercancel", pointer); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", hidden); };
  }, [release, stop]);
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || editable(event.target)) return;
    const key = event.key.toLowerCase();
    // Arrow keys inside native video controls keep their browser behavior.
    if (event.target === videoRef.current && key.startsWith("arrow")) { event.stopPropagation(); return; }
    if (key === " ") { event.preventDefault(); event.stopPropagation(); stop(); return; }
    const direction = keys.get(key); if (!direction) return;
    event.preventDefault(); event.stopPropagation(); if (!event.repeat) hold(`key:${key}`, direction);
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>, direction: Direction) => {
    if (event.button !== 0 || disabled || !decoded) return;
    event.preventDefault(); region.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture?.(event.pointerId); hold(`pointer:${event.pointerId}`, direction);
  };
  const jump = (end: boolean) => { stop(); const video = videoRef.current; if (video && decoded && !disabled) { video.currentTime = end ? video.duration : 0; progress(); } };
  return <section ref={region} aria-label="Saved walk playback" tabIndex={0} onKeyDown={keyDown}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stop(); }}>
    <h4>Walk this saved clip</h4>
    <p>Hold W / ↑ to move forward or S / ↓ to move back. Release or Space pauses. Playback is free.</p>
    <video key={src} ref={videoRef} controls playsInline muted preload="metadata" style={{ width: "100%", aspectRatio: `${width}/${height}` }} src={src}
      onLoadedMetadata={progress} onTimeUpdate={progress} onSeeked={progress} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onEnded={() => { progress(); stop(); }} onError={() => { stop(); setError("Saved walk video unavailable."); onError?.(); }}/>
    <div className={s.savedWalkActions}>
      {(["back", "forward"] as const).map(direction => <button key={direction} type="button" disabled={disabled || !decoded} aria-pressed={motion === direction}
        onKeyDown={event => { if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return; event.preventDefault(); event.stopPropagation(); if (!event.repeat) hold("button:enter", direction); }}
        style={{ touchAction: "none" }} onPointerDown={event => pointerDown(event, direction)} onPointerUp={event => release(`pointer:${event.pointerId}`)}
        onPointerCancel={event => release(`pointer:${event.pointerId}`)} onLostPointerCapture={event => release(`pointer:${event.pointerId}`)}>{direction === "forward" ? "Hold Forward" : "Hold Back"}</button>)}
      <button type="button" onClick={stop}>Pause</button>
      <button type="button" disabled={disabled || !decoded} onClick={() => jump(false)}>Back to start</button>
      <button type="button" disabled={disabled || !decoded} onClick={() => jump(true)}>Show end</button>
      {mapHref && <a href={mapHref} onClick={stop}>Open map</a>}
    </div>
    <progress aria-label="Saved clip progress" max={duration || 1} value={time}/>
    <p>{decoded ? `${time.toFixed(1)} / ${duration.toFixed(1)} seconds` : "Loading saved clip…"} · {motion === "back" ? "Moving backward" : playing || motion === "forward" ? "Moving forward" : "Paused"}</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
