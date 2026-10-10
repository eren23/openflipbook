"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type StreetDirection = "forward" | "left" | "right";
export interface StreetSegment {
  id: string; request_id?: string; request_ids?: string[]; parent_id: string | null;
  direction: StreetDirection; status: string; video_url?: string | null;
  video_sha256?: string | null; source_sha256?: string | null;
  end_frame_url?: string | null; end_frame_sha256?: string | null; provider_request_id?: string | null; error?: string | null; reservation: number;
}
interface Library { segments: StreetSegment[]; quote_ceiling_usd: number; duration_seconds: number }
interface Pending { request_id: string; direction: StreetDirection; parent_id: string | null }
interface Props { nodeId: string; imageUrl: string; title: string; disabled?: boolean }

// Paid street steps (up to $0.40 each). Off until generated legs keep the
// architecture of their source image; set NEXT_PUBLIC_STREET_WALK=1 to show.
export const STREET_WALK_ENABLED = ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_STREET_WALK ?? "").toLowerCase());

const pendingKey = (nodeId: string) => `openflipbook.street-walk.pending.${nodeId}`;
const matches = (segment: StreetSegment, id: string) => segment.id === id || segment.request_id === id || segment.request_ids?.includes(id);
const unresolved = (segment: StreetSegment) => !["ready", "failed"].includes(segment.status);

/** Read the completed clip's actual decoded end frame; never a still crop. */
export async function captureStreetEndpoint(video: HTMLVideoElement) {
  const duration = video.duration;
  if (!(duration > 0) || !Number.isFinite(duration) || !video.videoWidth || !video.videoHeight) throw new Error("The saved video has not decoded yet.");
  video.pause();
  const target = Math.max(0, duration - Math.min(1 / 30, duration / 2));
  if (Math.abs(video.currentTime - target) > .002) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { finish(); reject(new Error("The last video frame could not decode. Try saving the endpoint again.")); }, 10_000);
      const finish = () => { clearTimeout(timer); video.removeEventListener("seeked", done); video.removeEventListener("error", failed); };
      const done = () => { finish(); resolve(); };
      const failed = () => { finish(); reject(new Error("The last video frame could not decode.")); };
      video.addEventListener("seeked", done, { once: true }); video.addEventListener("error", failed, { once: true });
      video.currentTime = target;
    });
  }
  if (video.readyState < 2) throw new Error("The last video frame has not decoded yet.");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot save the decoded video frame.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { image_data_url: canvas.toDataURL("image/png"), time_seconds: video.currentTime, duration_seconds: duration };
}

export default function StreetWalkPlayer({ nodeId, imageUrl, title, disabled = false }: Props) {
  const base = `/api/nodes/${encodeURIComponent(nodeId)}/street-walk`;
  const [open, setOpen] = useState(false), [library, setLibrary] = useState<Library | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [savingFrame, setSavingFrame] = useState(false);
  const [receiptBlocked, setReceiptBlocked] = useState(false);
  const [writing, setWriting] = useState(false);
  const [atEnd, setAtEnd] = useState(false), [moving, setMoving] = useState<"forward" | "back" | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null), alive = useRef(true), readToken = useRef(0);
  const regionRef = useRef<HTMLElement | null>(null), activeWrite = useRef<string | null>(null);
  const pendingRef = useRef<Pending | null>(null), selectedRef = useRef<string | null>(null), frameToken = useRef(0);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const holds = useRef(new Map<string, "forward" | "back">()), reverseRaf = useRef(0), frameBusy = useRef(false);
  const entry = useRef<{ id: string; position: "start" | "end"; preserveHold: boolean } | null>(null);
  const selectionEpoch = useRef(0), pendingSelectionEpoch = useRef<number | null>(null);
  selectedRef.current = selectedId;
  const selected = library?.segments.find((segment) => segment.id === selectedId) ?? null;
  const hasUnresolved = !!library?.segments.some(unresolved);
  const ready = selected?.status === "ready" && !!selected.video_url;
  const controller = useRef({ library, selected, disabled }); controller.current = { library, selected, disabled };
  const quoteReady = library?.quote_ceiling_usd === .4 && library.duration_seconds === 5;
  const mayStep = !disabled && !receiptBlocked && !writing && !pending && !hasUnresolved && !savingFrame && quoteReady && !moving && (!selected ? library?.segments.length === 0 : ready && atEnd && !!selected.end_frame_url);
  const mayEnterSaved = !disabled && !savingFrame && !moving && ready && atEnd && !!selected?.end_frame_url;

  const stop = useCallback(() => {
    if (entry.current) entry.current.preserveHold = false;
    holds.current.clear(); cancelAnimationFrame(reverseRaf.current); reverseRaf.current = 0;
    videoRef.current?.pause(); setMoving(null);
  }, []);
  useEffect(() => {
    const lifetime = { alive, readToken, frameToken, holds, reverseRaf, videoRef, readController, writeController };
    alive.current = true;
    return () => { lifetime.alive.current = false; ++lifetime.readToken.current; ++lifetime.frameToken.current; lifetime.holds.current.clear(); cancelAnimationFrame(lifetime.reverseRaf.current); lifetime.videoRef.current?.pause(); lifetime.readController.current?.abort(); lifetime.writeController.current?.abort(); };
  }, [nodeId]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);
  useLayoutEffect(() => {
    if (entry.current?.id === selectedId) {
      cancelAnimationFrame(reverseRaf.current); reverseRaf.current = 0; videoRef.current?.pause();
      if (!entry.current.preserveHold) { holds.current.clear(); setMoving(null); }
    } else { entry.current = null; stop(); }
    setAtEnd(false); ++frameToken.current; setSavingFrame(false); frameBusy.current = false;
  }, [selectedId, stop]);
  useEffect(() => {
    if (!open) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    regionRef.current?.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [open]);

  const clearPending = useCallback(() => {
    pendingRef.current = null; setPending(null);
    try { window.sessionStorage.removeItem(pendingKey(nodeId)); } catch { /* An acknowledged server receipt remains authoritative. */ }
  }, [nodeId]);
  const refresh = useCallback(async () => {
    const token = ++readToken.current;
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller;
    setLoading(true);
    try {
      const response = await fetch(base, { signal: controller.signal, cache: "no-store" });
      const body = await response.json() as Library & { error?: string };
      if (!response.ok || !Array.isArray(body.segments)) throw new Error(body.error || "Saved street steps could not load.");
      if (!alive.current || token !== readToken.current) return;
      setLibrary(body);
      const held = pendingRef.current;
      const recovered = held ? body.segments.find((segment) => matches(segment, held.request_id)) : null;
      if (!receiptBlocked && (!held || recovered)) setError(null);
      if (recovered) {
        const maySelect = pendingSelectionEpoch.current === null || pendingSelectionEpoch.current === selectionEpoch.current;
        clearPending(); pendingSelectionEpoch.current = null;
        if (maySelect) setSelectedId(recovered.id);
      }
      else setSelectedId((current) => body.segments.some((segment) => segment.id === current) ? current : body.segments.at(-1)?.id ?? null);
      // An exact terminal GET receipt resolves an otherwise hanging POST,
      // including when a previous GET already acknowledged its pending row.
      // A late response must not unlock a newer operation's controls.
      if (activeWrite.current && body.segments.some((segment) => matches(segment, activeWrite.current!) && ["ready", "failed"].includes(segment.status))) { activeWrite.current = null; writeController.current?.abort(); setWriting(false); }
    } catch (failure) { if (alive.current && token === readToken.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Saved street steps could not load."); }
    finally { if (alive.current && token === readToken.current) setLoading(false); }
  }, [base, clearPending, receiptBlocked]);
  useEffect(() => {
    if (!open) return;
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(pendingKey(nodeId)) ?? "null") as Pending | null;
      if (stored) {
        if (!/^[0-9a-f-]{36}$/i.test(stored.request_id) || !["forward", "left", "right"].includes(stored.direction) || !(stored.parent_id === null || typeof stored.parent_id === "string")) throw new Error("Invalid receipt");
        pendingRef.current = stored; setPending(stored);
      }
    } catch { setReceiptBlocked(true); setError("The previous request receipt could not load. Check saved steps before generating."); }
    void refresh();
  }, [nodeId, open, refresh]);
  useEffect(() => {
    if (!open || !pending && !hasUnresolved) return;
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [open, pending, hasUnresolved, refresh]);

  const submit = async (request: Pending, path: string) => {
    try { window.sessionStorage.setItem(pendingKey(nodeId), JSON.stringify(request)); }
    catch { setError("The request receipt could not be retained. No step was submitted."); return; }
    pendingRef.current = request; activeWrite.current = request.request_id; pendingSelectionEpoch.current = selectionEpoch.current; setPending(request); setWriting(true); setError(null); stop();
    const controller = new AbortController(); writeController.current = controller;
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
      const body = await response.json() as { segment?: StreetSegment; error?: string };
      if (!response.ok || !body.segment || !matches(body.segment, request.request_id)) throw new Error(body.error || "The step acknowledgement is unresolved. Check saved steps; no new request will be sent.");
      if (!alive.current || pendingRef.current?.request_id !== request.request_id) return;
      const maySelect = pendingSelectionEpoch.current === selectionEpoch.current;
      clearPending(); pendingSelectionEpoch.current = null;
      if (maySelect) setSelectedId(body.segment.id);
      setLibrary((previous) => previous ? { ...previous, segments: [...previous.segments.filter((segment) => segment.id !== body.segment!.id), body.segment!] } : previous);
    } catch (failure) {
      if (alive.current && pendingRef.current?.request_id === request.request_id) setError(failure instanceof Error ? failure.message : "The step acknowledgement is unresolved. Check saved steps.");
    } finally { if (alive.current) { if (activeWrite.current === request.request_id) { activeWrite.current = null; setWriting(false); } void refresh(); } }
  };
  const generate = async (direction: StreetDirection) => {
    if (!mayStep || pendingRef.current) return;
    await submit({ request_id: crypto.randomUUID(), direction, parent_id: selected?.id ?? null }, base);
  };
  const recover = async () => {
    if (!selected || disabled || writing || pendingRef.current || !(selected.status === "storage_failed" || selected.status === "submission_unknown" && selected.provider_request_id)) return;
    // These server branches only retrieve an acknowledged provider result or
    // copy the existing bytes. They never create a UUID or submit a model.
    await submit({ request_id: selected.request_id ?? selected.id, direction: selected.direction, parent_id: selected.parent_id }, base);
  };

  const saveEndpoint = async (segment: StreetSegment, video: HTMLVideoElement) => {
    stop(); setAtEnd(true);
    if (segment.end_frame_url || frameBusy.current || !segment.video_sha256) return;
    const token = ++frameToken.current; frameBusy.current = true; setSavingFrame(true); setError(null);
    try {
      const capture = await captureStreetEndpoint(video);
      if (!alive.current || token !== frameToken.current || selectedRef.current !== segment.id) return;
      const response = await fetch(`${base}/${encodeURIComponent(segment.id)}/frame`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...capture, video_sha256: segment.video_sha256 }) });
      const body = await response.json() as { end_frame_url?: string; sha256?: string; error?: string };
      if (!response.ok || !body.end_frame_url || !body.sha256) throw new Error(body.error || "The endpoint was not saved. Check saved steps before continuing.");
      if (!alive.current || token !== frameToken.current || selectedRef.current !== segment.id) return;
      setLibrary((previous) => previous ? { ...previous, segments: previous.segments.map((item) => item.id === segment.id ? { ...item, end_frame_url: body.end_frame_url!, end_frame_sha256: body.sha256! } : item) } : previous);
    } catch (failure) { if (alive.current && token === frameToken.current) setError(failure instanceof Error ? failure.message : "The endpoint was not saved."); }
    finally { if (alive.current && token === frameToken.current) { frameBusy.current = false; setSavingFrame(false); } }
  };

  const savedChild = useCallback((direction: StreetDirection) => {
    const state = controller.current, parent = state.selected;
    if (!parent?.end_frame_url) return null;
    return state.library?.segments.find((candidate) => candidate.id !== parent.id && candidate.parent_id === parent.id && candidate.direction === direction && candidate.status === "ready" && candidate.video_url && (!parent.end_frame_sha256 || candidate.source_sha256 === parent.end_frame_sha256)) ?? null;
  }, []);
  const enterSaved = useCallback((target: StreetSegment, position: "start" | "end", preserveHold: boolean) => {
    const state = controller.current;
    if (state.disabled || target.status !== "ready" || !target.video_url || target.id === state.selected?.id) return false;
    if (!preserveHold) stop();
    else { videoRef.current?.pause(); cancelAnimationFrame(reverseRaf.current); reverseRaf.current = 0; }
    ++selectionEpoch.current; entry.current = { id: target.id, position, preserveHold }; setSelectedId(target.id);
    return true;
  }, [stop]);
  const updateMotion = useCallback(() => {
    const video = videoRef.current;
    cancelAnimationFrame(reverseRaf.current); reverseRaf.current = 0;
    if (!video || !holds.current.size || disabled) { video?.pause(); setMoving(null); return; }
    if ([...holds.current.values()].includes("back")) {
      video.pause(); setMoving("back"); let previous: number | null = null;
      const reverse = (now: number) => {
        if (!alive.current || !holds.current.size || ![...holds.current.values()].includes("back")) return;
        const elapsed = previous === null ? 0 : Math.min(.05, Math.max(0, (now - previous) / 1000)); previous = now;
        video.currentTime = Math.max(0, video.currentTime - elapsed); setAtEnd(false);
        if (video.currentTime > 0) reverseRaf.current = requestAnimationFrame(reverse);
        else {
          const state = controller.current, parent = state.library?.segments.find((candidate) => candidate.id === state.selected?.parent_id && candidate.status === "ready" && candidate.video_url && candidate.end_frame_url && (!candidate.end_frame_sha256 || candidate.end_frame_sha256 === state.selected?.source_sha256));
          if (!parent || !enterSaved(parent, "end", true)) stop();
        }
      };
      reverseRaf.current = requestAnimationFrame(reverse);
    } else {
      if (video.ended || Number.isFinite(video.duration) && video.currentTime >= video.duration) {
        const child = savedChild("forward");
        if (!child || !enterSaved(child, "start", true)) stop();
        return;
      }
      setMoving("forward"); void video.play().catch(() => { if (alive.current && videoRef.current === video) { holds.current.clear(); setMoving(null); setError("Press Forward again to play the saved step."); } });
    }
  }, [disabled, enterSaved, savedChild, stop]);
  const hold = useCallback((source: string, direction: "forward" | "back") => { if (!ready || savingFrame || disabled) return; holds.current.set(source, direction); updateMotion(); }, [ready, savingFrame, disabled, updateMotion]);
  const release = useCallback((source: string) => { holds.current.delete(source); updateMotion(); }, [updateMotion]);
  const completed = (segment: StreetSegment, video: HTMLVideoElement) => {
    if (selectedRef.current !== segment.id) return;
    const child = savedChild("forward");
    if (holds.current.size && ![...holds.current.values()].includes("back") && child && enterSaved(child, "start", true)) return;
    void saveEndpoint(segment, video);
  };
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      const value = event.key.toLowerCase();
      // Release still applies if focus/modifiers changed while a key was held.
      if (event.type === "keyup" && ["w", "arrowup", "s", "arrowdown"].includes(value)) { release(`key:${value}`); return; }
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.isContentEditable || target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (!["w", "arrowup", "s", "arrowdown", " "].includes(value)) return;
      event.preventDefault();
      if (value === " ") { stop(); return; }
      if (event.type === "keyup") release(`key:${value}`);
      else if (!event.repeat) hold(`key:${value}`, ["s", "arrowdown"].includes(value) ? "back" : "forward");
    };
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener("keydown", key); window.addEventListener("keyup", key); window.addEventListener("blur", stop); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("keyup", key); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", hidden); stop(); };
  }, [open, hold, release, stop]);

  if (!open) return <section ref={regionRef} aria-label="Street walking" className="rounded-xl border border-[var(--color-edge)] p-4"><button type="button" disabled={disabled} className="rounded-lg bg-emerald-800 px-4 py-2 font-semibold text-white disabled:opacity-50" onClick={() => setOpen(true)}>Walk in this street</button><p className="mt-2 text-sm opacity-70">Start inside {title}. Move through saved steps and choose where to go next.</p></section>;
  return <section ref={regionRef} aria-label="Street walking" className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-canvas)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-lg">Walk in this street</h2><button type="button" onClick={() => { stop(); setOpen(false); }}>Close walking</button></div>
    <p className="my-2 text-sm opacity-70">Hold W / ↑ or Forward to walk. Hold S / ↓ to move back through this step. Space pauses. New steps are generated from where the last one ended.</p>
    <div className="overflow-hidden rounded-lg bg-black">
      {ready && selected ? <video key={selected.id} ref={videoRef} data-testid="street-walk-video" data-segment-id={selected.id} src={selected.video_url!} poster={library?.segments.find((item) => item.id === selected.parent_id)?.end_frame_url ?? imageUrl} muted playsInline preload="auto" className="block max-h-[70dvh] w-full object-contain"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget, crossing = entry.current?.id === selected.id ? entry.current : null;
          video.pause(); entry.current = null;
          if (crossing) {
            video.currentTime = crossing.position === "end" && Number.isFinite(video.duration) ? Math.max(0, video.duration - 1 / 30) : 0;
            setAtEnd(crossing.position === "end" && !!selected.end_frame_url);
            if (crossing.preserveHold && holds.current.size) updateMotion();
          } else if (selected.end_frame_url && Number.isFinite(video.duration)) { video.currentTime = Math.max(0, video.duration - 1 / 30); setAtEnd(true); }
        }}
        onTimeUpdate={(event) => { if (event.currentTarget.currentTime < event.currentTarget.duration - .06) setAtEnd(false); }}
        onEnded={(event) => { completed(selected, event.currentTarget); }}/>
        // These private source pixels must retain their exact dimensions and URL.
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={library?.segments.find((item) => item.id === selected?.parent_id)?.end_frame_url ?? imageUrl} alt={`Starting street view: ${title}`} className="block max-h-[70dvh] w-full object-contain"/>}
    </div>
    <div role="status" aria-live="polite" className="my-2 text-sm">{pending ? "Preparing your step. The request is retained; checking saved progress." : selected && unresolved(selected) ? `Step ${selected.status.replaceAll("_", " ")}. Check saved progress; no new step will be submitted.` : savingFrame ? "Saving the last decoded frame…" : moving === "back" ? "Moving back through the saved step" : moving ? "Walking forward" : atEnd ? selected?.end_frame_url ? "At the saved endpoint. Choose your next step." : "Endpoint needs to be saved before continuing." : ready ? "Paused. Hold Forward to walk through this step." : "Ready to take your first step."}</div>
    {(error || selected?.error) && <p role="alert" className="my-2 text-sm text-red-700">{error ?? selected?.error}</p>}
    <div className="flex flex-wrap gap-2">
      {(["forward", "back"] as const).map((direction) => <button key={direction} type="button" disabled={!ready || savingFrame || disabled} className="touch-none rounded-lg border border-[var(--color-edge)] px-4 py-2 disabled:opacity-50" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); hold(`pointer:${direction}:${event.pointerId}`, direction); }} onPointerUp={(event) => release(`pointer:${direction}:${event.pointerId}`)} onPointerCancel={(event) => release(`pointer:${direction}:${event.pointerId}`)} onLostPointerCapture={(event) => release(`pointer:${direction}:${event.pointerId}`)}>{direction === "forward" ? "Forward (hold)" : "Back (hold)"}</button>)}
      <button type="button" onClick={stop}>Pause</button>
      {ready && <button type="button" disabled={savingFrame} onClick={() => { stop(); if (videoRef.current) videoRef.current.currentTime = 0; setAtEnd(false); }}>Replay this step</button>}
      {ready && selected && atEnd && !selected.end_frame_url && <button type="button" disabled={savingFrame || disabled} onClick={() => { if (videoRef.current) void saveEndpoint(selected, videoRef.current); }}>Save endpoint</button>}
      <button type="button" disabled={loading} onClick={() => { void refresh(); }}>Check saved steps</button>
      {selected && (selected.status === "storage_failed" || selected.status === "submission_unknown" && selected.provider_request_id) && <button type="button" disabled={disabled || writing || !!pending || receiptBlocked} onClick={() => { void recover(); }}>Recover saved step — $0</button>}
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={savedChild("forward") ? !mayEnterSaved : !mayStep} className="rounded-lg bg-emerald-800 px-4 py-2 font-semibold text-white disabled:opacity-50" onClick={() => { const child = savedChild("forward"); if (child && mayEnterSaved) enterSaved(child, "start", false); else if (!child) void generate("forward"); }}>{savedChild("forward") ? "Walk saved forward step — free" : `${selected ? "Continue walking" : "Generate forward step"} — up to $0.40`}</button>
      {selected && (["left", "right"] as const).map((direction) => <button key={direction} type="button" disabled={savedChild(direction) ? !mayEnterSaved : !mayStep} className="rounded-lg border border-[var(--color-edge)] px-3 py-2 disabled:opacity-50" onClick={() => { const child = savedChild(direction); if (child && mayEnterSaved) enterSaved(child, "start", false); else if (!child) void generate(direction); }}>{savedChild(direction) ? `Take saved ${direction} turn — free` : `Turn ${direction} — up to $0.40`}</button>)}
    </div>
    <p className="mt-2 text-xs opacity-60">Each new direction makes a 5-second AI walking step. Playing, pausing and moving back use the saved video for free.</p>
    {!!library?.segments.length && <div role="group" aria-label="Saved street steps" className="mt-3 flex flex-wrap gap-2">{library.segments.map((segment, index) => <button key={segment.id} type="button" aria-pressed={segment.id === selectedId} className="rounded border border-[var(--color-edge)] px-2 py-1 text-sm" onClick={() => { ++selectionEpoch.current; entry.current = null; stop(); setSelectedId(segment.id); }}>Step {index + 1} · {segment.direction}</button>)}</div>}
  </section>;
}
