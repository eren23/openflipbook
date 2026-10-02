"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Check, RefreshCw, Sparkles, SquareDashedMousePointer, X } from "lucide-react";
import type { MeshJob } from "@/lib/mesh-asset";
import type { IllustrationKeyframe, SavedIllustration, SavedPlaceView } from "@/lib/place-view";
import s from "./world-editor.module.css";
import IllustrationRegionPicker from "./illustration-region-picker";
import type { IllustrationBrushStroke } from "@/lib/illustration-brush";
import IllustrationSurface from "./illustration-surface";

interface Library {
  jobs: MeshJob[]; assets: SavedIllustration[]; historical: boolean; accepted_id: string | null;
  capabilities: { enabled: boolean; model: string; reservation: number; parameters: Record<string, unknown>; reason?: string; brush_enabled?: boolean };
  region_capabilities?: Library["capabilities"];
  keyframe_capabilities?: Library["capabilities"]; chain_sources?: { view_id: string; label: string }[];
}
const active = (job: MeshJob) => ["scheduled", "submitting", "queued", "running", "storing"].includes(job.status);
const signed = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
function gateSummary(k: IllustrationKeyframe) {
  const m = k.candidates[k.chosen], kind = k.stage === "chain" ? "Chained keyframe" : k.art === "words" ? "Keyframe from words" : "Keyframe from art";
  const gate = `${kind} / gate ${k.gate}`;
  return m?.iou == null || m.centre_dx == null || m.centre_dy == null || m.area_ratio == null ? gate : `${gate} / IoU ${m.iou.toFixed(3)} / centre ${signed(m.centre_dx)}, ${signed(m.centre_dy)} / area ${m.area_ratio.toFixed(2)}`;
}
export default function PlaceIllustrations({ sessionId, view, previousView, disabled, surfaceTarget, selectedObject, onSelectObject, onPendingChange }: {
  sessionId: string; view: SavedPlaceView; previousView?: SavedPlaceView | undefined; disabled: boolean;
  surfaceTarget?: HTMLElement | null | undefined; selectedObject?: string | null | undefined;
  onSelectObject?: ((id: string) => void) | undefined; onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const [library, setLibrary] = useState<Library | null>(null), [prompt, setPrompt] = useState("");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState(""), [comparison, setComparison] = useState<"illustration" | "source" | "previous" | "overlay">("illustration"), [loadedKey, setLoadedKey] = useState("");
  const [sourceOpacity, setSourceOpacity] = useState(50);
  const [editingRegion, setEditingRegion] = useState(false), [regionIds, setRegionIds] = useState<string[]>([]), [maskReady, setMaskReady] = useState(false);
  const [strokes, setStrokes] = useState<IllustrationBrushStroke[] | undefined>();
  const [chainFrom, setChainFrom] = useState("");
  const regionPending = useRef<Record<string, unknown> | null>(null);
  const maskedPending = useRef<Record<string, unknown> | null>(null);
  const [regionMode, setRegionMode] = useState<"proposal" | "generate">("proposal"), [changePrompt, setChangePrompt] = useState(""), [editConsent, setEditConsent] = useState(false);
  const pending = useRef<Record<string, unknown> | null>(null), epoch = useRef({ value: 0 }), mounted = useRef(true);
  const quotation = useRef("");
  const endpoint = `/api/world/${encodeURIComponent(sessionId)}/views/${encodeURIComponent(view.id)}/illustrations`;
  const reload = useCallback(async () => {
    const read = ++epoch.current.value, response = await fetch(endpoint, { cache: "no-store" }), data = await response.json();
    if (!mounted.current || read !== epoch.current.value) return;
    if (!response.ok) throw new Error(data.error || "Illustrations unavailable");
    if (!Array.isArray(data.jobs) || !Array.isArray(data.assets) || !data.capabilities) throw new Error("Invalid illustration library response");
    const quote = JSON.stringify([data.capabilities, data.keyframe_capabilities]);
    if (quotation.current !== quote && !pending.current) setConsent(false);
    quotation.current = quote;
    setLibrary(data); setSelected(old => data.assets.some((a: SavedIllustration) => a.id === old) ? old : data.accepted_id ?? data.assets[0]?.id ?? "");
  }, [endpoint]);
  useEffect(() => { const state = epoch.current; mounted.current = true; void reload().catch(e => { if (mounted.current) setError(e.message); }); return () => { mounted.current = false; state.value++; }; }, [reload, view.historical]);
  const polling = library?.jobs.some(active) ?? false;
  useEffect(() => {
    if (busy || !polling) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await reload(); } catch (e) { if (!stopped) setError((e as Error).message); }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [polling, busy, reload]);
  useEffect(() => { setEditingRegion(false); setRegionIds([]); setStrokes(undefined); setMaskReady(false); setComparison("illustration"); setSourceOpacity(50); }, [selected, view.id]);
  const editQuote = JSON.stringify(library?.region_capabilities);
  useEffect(() => { if (!maskedPending.current) setEditConsent(false); }, [editQuote, library?.accepted_id, regionIds, regionMode, strokes]);
  async function action(body: Record<string, unknown>, retained?: "generation" | "region" | "masked") {
    if (busy) return;
    epoch.current.value++; setBusy(true); setError("");
    try {
      const retry = retained === "generation" ? pending : retained === "region" ? regionPending : retained === "masked" ? maskedPending : null;
      if (retry) retry.current ??= body;
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(retry ? retry.current : body) });
      const data = await response.json();
      if (!response.ok) {
        if (retry && [400, 403, 404, 409, 413, 429].includes(response.status)) { retry.current = null; setConsent(false); setEditConsent(false); }
        throw new Error(data.error || "Illustration request failed");
      }
      if (retry) { retry.current = null; setConsent(false); }
      await reload();
      if (retained === "region" && mounted.current && typeof data.id === "string") { setSelected(data.id); setComparison("illustration"); }
      if (retained === "masked" && mounted.current) { setEditConsent(false); setEditingRegion(false); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  const asset = library?.assets.find(a => a.id === selected), config = library?.capabilities;
  const historical = view.historical || library?.historical;
  const frozen = busy || !!pending.current || !!regionPending.current || !!maskedPending.current;
  useEffect(() => { onPendingChange?.(frozen); }, [frozen, onPendingChange]);
  const editConfig = library?.region_capabilities;
  // When keyframes are on they replace the full-view flux generation; flux jobs and region edits stay.
  const keyframeConfig = library?.keyframe_capabilities, keyframes = !!keyframeConfig?.enabled, quote = keyframes ? keyframeConfig : config;
  const chain = library?.chain_sources?.some(v => v.view_id === chainFrom) ? chainFrom : "";
  const paint = (text: string, extra: Record<string, unknown>) => void action({ action: "generate_keyframe", id: crypto.randomUUID(), prompt: text, confirmed: true, model: keyframeConfig?.model, parameters: keyframeConfig?.parameters, reservation: keyframeConfig?.reservation, ...extra }, "generation");
  // The retry ladder: a first keyframe painted from art retries from words; a chain retries once.
  const kf = asset?.keyframe, rung = kf?.gate !== "failed" ? null : kf.stage === "first" ? kf.art === "art" ? { label: "Retry with words only", extra: { art: false } } : null
    : kf.chain_from && (library?.assets.filter(a => a.keyframe?.chain_from?.illustration_id === kf.chain_from!.illustration_id).length ?? 0) < 2 ? { label: "Retry chain once", extra: { chain_from: kf.chain_from.view_id } } : null;
  const imageUrl = (id: string) => `/api/world/${encodeURIComponent(sessionId)}/illustrations/${encodeURIComponent(id)}`;
  const renderUrl = `/api/world/${encodeURIComponent(sessionId)}/views/${encodeURIComponent(view.id)}/render`;
  const previous = asset?.geometry_refresh ?? asset?.region_edit;
  const previousUrl = previous?.base_id ? imageUrl(previous.base_id) : asset?.geometry_refresh
    ? `/api/world/${encodeURIComponent(sessionId)}/views/${encodeURIComponent(asset.geometry_refresh.base_view.view_id)}/render` : renderUrl;
  const retryRefresh = regionPending.current?.action === "compose_refresh";
  const selectRegions = (ids: string[]) => { setRegionIds(ids); if (ids.length) onSelectObject?.(ids.at(-1)!); };
  // Keyed to the shown image, not reset by an effect: next/image fires onLoad
  // during commit for an image that is already complete (a cached one), which
  // is before a reset effect would run, and never fires again for that src.
  const shownKey = `${view.id}:${selected}`, loaded = loadedKey === shownKey;
  const imageLoaded = () => setLoadedKey(shownKey);
  const imageFailed = () => { setLoadedKey(""); setError("Saved illustration image unavailable."); };
  return <div className={s.illustrationGenerator} aria-label="Camera illustrations">
    <div className={s.sectionHeading}><h3>Illustrations</h3><button title="Refresh illustrations" aria-label="Refresh illustrations" disabled={busy} onClick={() => void reload().catch(e => setError(e.message))}><RefreshCw size={16}/></button></div>
    {!editingRegion && <><label>Appearance<textarea aria-label="Illustration appearance" value={prompt} maxLength={1024} disabled={frozen} onChange={e => setPrompt(e.target.value)} placeholder="Hand-inked stonework, mossy roofs, warm window light"/></label>
    {keyframes && !!library?.chain_sources?.length && <label>Continue from<select aria-label="Continue from camera" value={chain} disabled={frozen} onChange={e => setChainFrom(e.target.value)}><option value="">3D render (first keyframe)</option>{library.chain_sources.map(v => <option key={v.view_id} value={v.view_id}>{v.label}</option>)}</select></label>}
    {quote?.enabled && <label className={s.checkbox}><input type="checkbox" checked={consent} disabled={busy || !!pending.current} onChange={e => setConsent(e.target.checked)}/>Reserve {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(quote.reservation)} for this {keyframes ? "keyframe" : "illustration"}</label>}
    {quote && !quote.enabled && <p role="status">{quote.reason}</p>}
    {keyframes ? <button disabled={busy || !!regionPending.current || !!maskedPending.current || (!pending.current && (disabled || historical || !consent || prompt.trim().length < 3))} onClick={() => paint(prompt, chain ? { chain_from: chain } : {})}><Sparkles size={16}/>{pending.current ? "Retry keyframe request" : "Paint keyframe"}</button>
    : <button disabled={busy || !!regionPending.current || !!maskedPending.current || (!pending.current && (disabled || historical || !config?.enabled || !consent || prompt.trim().length < 3))} onClick={() => void action({ action: "generate", id: crypto.randomUUID(), prompt, confirmed: true, model: config?.model, parameters: config?.parameters, reservation: config?.reservation }, "generation")}><Sparkles size={16}/>{pending.current ? "Retry illustration request" : "Generate illustration"}</button>}</>}
    {library?.jobs.map(job => <div key={job.id} className={s.illustrationJob}>
      <span>{job.prompt}</span><span role="status">{job.status.replaceAll("_", " ")}</span>
      {job.error && <p>{job.error}</p>}
      {job.asset_id && <button disabled={frozen} onClick={() => { setSelected(job.asset_id!); setComparison("illustration"); }}>Review result</button>}
      {job.status === "storage_failed" && <button disabled={busy} onClick={() => void action({ action: "refresh", id: job.id })}><RefreshCw size={14}/>Retry storage</button>}
      {!["ready", "failed", "cancelled"].includes(job.status) && <button disabled={busy} title="Cancel illustration" aria-label={`Cancel illustration ${job.id}`} onClick={() => void action({ action: "cancel", id: job.id })}><X size={14}/></button>}
    </div>)}
    {!!library?.assets.length && <label>Illustration<select aria-label="Saved illustration" value={selected} disabled={frozen} onChange={e => { setSelected(e.target.value); setComparison("illustration"); }}>{library.assets.map(a => <option key={a.id} value={a.id}>{a.geometry_refresh ? " / protected refresh" : a.region_edit ? " / selected edit" : a.edit_input ? " / masked proposal" : a.keyframe ? " / keyframe" : ""}{a.accepted ? " / accepted" : " / draft"}{a.historical ? " / historical" : ""}</option>)}</select></label>}
    {asset && <>
      {!editingRegion && <div className={s.viewPasses} role="group" aria-label="Illustration comparison"><button aria-pressed={comparison === "illustration"} onClick={() => setComparison("illustration")}>Illustration</button><button aria-pressed={comparison === "source"} onClick={() => setComparison("source")}>Source render</button><button aria-pressed={comparison === "overlay"} onClick={() => setComparison("overlay")}>Overlay</button>{previous && <button aria-pressed={comparison === "previous"} onClick={() => setComparison("previous")}>Previous artwork</button>}</div>}
      {!editingRegion && comparison === "overlay" && <label className={s.comparisonOpacity}>Source opacity <output>{sourceOpacity}%</output><input type="range" aria-label="Source render opacity" aria-valuetext={`${sourceOpacity}% source render`} min={0} max={100} step={5} value={sourceOpacity} onChange={e => setSourceOpacity(Number(e.target.value))}/></label>}
      {editingRegion && <div className={s.viewPasses} role="group" aria-label="Region edit mode"><button aria-pressed={regionMode === "proposal"} disabled={frozen} onClick={() => setRegionMode("proposal")}>Apply draft</button><button aria-pressed={regionMode === "generate"} disabled={frozen} onClick={() => setRegionMode("generate")}>Generate change</button></div>}
      {editingRegion ? <IllustrationRegionPicker sessionId={sessionId} view={view} surfaceTarget={surfaceTarget} imageUrl={regionMode === "generate" ? library?.accepted_id ? imageUrl(library.accepted_id) : renderUrl : imageUrl(asset.id)} selected={regionIds} onChange={selectRegions} strokes={strokes} onBrushChange={setStrokes} onReady={setMaskReady} disabled={frozen || disabled || !!historical}/> : surfaceTarget && comparison === "illustration" && !!view.objects?.length ? <IllustrationRegionPicker sessionId={sessionId} view={view} surfaceTarget={surfaceTarget} imageUrl={imageUrl(asset.id)} imageLabel="Generated camera illustration" onImageLoad={imageLoaded} onImageError={imageFailed} selected={selectedObject ? [selectedObject] : []} onChange={ids => { if (ids.length) onSelectObject?.(ids.at(-1)!); }} onReady={setMaskReady} showObjects={false} disabled={frozen}/> : <IllustrationSurface target={surfaceTarget} width={view.width} height={view.height}>
        <Image key={asset.id} unoptimized src={imageUrl(asset.id)} alt="Generated camera illustration" fill sizes={surfaceTarget ? "100vw" : "320px"} style={{ objectFit: "contain", visibility: comparison === "source" || comparison === "previous" ? "hidden" : "visible" }} onLoad={imageLoaded} onError={imageFailed}/>
        {(comparison === "source" || comparison === "overlay") && <Image unoptimized src={renderUrl} alt="Illustration source geometry" fill sizes={surfaceTarget ? "100vw" : "320px"} style={{ objectFit: "contain", opacity: comparison === "overlay" ? sourceOpacity / 100 : 1, pointerEvents: "none" }} onLoad={() => setError(old => old === "Saved source render unavailable." ? "" : old)} onError={() => setError("Saved source render unavailable.")}/>}
        {comparison === "previous" && previous && <Image unoptimized src={previousUrl} alt="Region edit previous artwork" fill sizes={surfaceTarget ? "100vw" : "320px"} style={{ objectFit: "contain" }}/>}
      </IllustrationSurface>}
      {!editingRegion && asset.region_edit && <p>{asset.region_edit.object_ids.length} objects / {asset.region_edit.protected_pixels.toLocaleString()} protected pixels</p>}
      {!editingRegion && kf && <p role="status" aria-label="Keyframe gate">{gateSummary(kf)}</p>}
      {!editingRegion && rung && <button disabled={frozen || disabled || historical || !keyframes || !consent} onClick={() => paint(asset.prompt, rung.extra)}><Sparkles size={16}/>{rung.label}</button>}
      {!editingRegion && asset.geometry_refresh && <p>{asset.geometry_refresh.changed_pixels.toLocaleString()} refreshed pixels / {asset.geometry_refresh.protected_pixels.toLocaleString()} protected pixels</p>}
      {!editingRegion && previousView && previousView.id === view.refreshed_from && !asset.edit_input && !asset.region_edit && !asset.geometry_refresh && <button disabled={busy || (!retryRefresh && (frozen || disabled || historical || !loaded))} onClick={() => void action({ action: "compose_refresh", id: crypto.randomUUID(), proposal_id: asset.id, base_id: previousView.accepted_illustration_id ?? null, previous_id: library?.accepted_id ?? null }, "region")}><RefreshCw size={16}/>{retryRefresh ? "Retry artwork refresh" : "Preview protected refresh"}</button>}
      {!editingRegion && (asset.edit_input ? <button disabled={busy || (!regionPending.current && (frozen || disabled || historical || !loaded))} onClick={() => void action({ action: "compose", id: crypto.randomUUID(), proposal_id: asset.id, base_id: asset.edit_input!.base_id, object_ids: asset.edit_input!.object_ids, ...(asset.edit_input!.brush_strokes ? { brush_strokes: asset.edit_input!.brush_strokes } : {}) }, "region")}><SquareDashedMousePointer size={16}/>{regionPending.current ? "Retry selected edit" : "Preview protected result"}</button> : <button disabled={frozen || disabled || historical || asset.accepted || !loaded} onClick={() => void action({ action: "accept", id: asset.id, previous_id: library?.accepted_id ?? null })}><Check size={16}/>{asset.accepted ? "Accepted illustration" : "Accept illustration"}</button>)}
      {!!view.objects?.length && <button aria-pressed={editingRegion} disabled={frozen || disabled || historical || !loaded} onClick={() => { setEditingRegion(!editingRegion); setRegionIds(surfaceTarget && selectedObject && view.objects.some(o => o.object_id === selectedObject) ? [selectedObject] : []); setStrokes(undefined); setMaskReady(false); }}>{editingRegion ? <X size={16}/> : <SquareDashedMousePointer size={16}/>}{editingRegion ? "Close region edit" : "Edit selected objects"}</button>}
      {editingRegion && regionMode === "proposal" && <>
        <button disabled={busy || (!regionPending.current && (disabled || historical || !maskReady || !regionIds.length))} onClick={() => void action({ action: "compose", id: crypto.randomUUID(), proposal_id: asset.id, base_id: library?.accepted_id ?? null, object_ids: regionIds, ...(strokes ? { brush_strokes: strokes } : {}) }, "region")}><SquareDashedMousePointer size={16}/>{regionPending.current ? "Retry selected edit" : "Preview selected edit"}</button>
      </>}
      {editingRegion && regionMode === "generate" && <>
        <label>Requested change<textarea aria-label="Selected object change" value={changePrompt} maxLength={1024} disabled={frozen} onChange={e => { setChangePrompt(e.target.value); setEditConsent(false); }}/></label>
        {editConfig?.enabled ? <label className={s.checkbox}><input type="checkbox" aria-label="Approve masked generation reservation" checked={editConsent} disabled={frozen} onChange={e => setEditConsent(e.target.checked)}/>Reserve ${editConfig.reservation.toFixed(4)} for this masked change</label> : <p role="status">{editConfig?.reason ?? "Masked generation is not configured."}</p>}
        {strokes && !editConfig?.brush_enabled && <p role="status">A compatible brush-generation worker is unavailable.</p>}
        <button disabled={busy || (!maskedPending.current && (disabled || historical || !maskReady || !regionIds.length || !editConfig?.enabled || strokes !== undefined && !editConfig.brush_enabled || !editConsent || changePrompt.trim().length < 3))} onClick={() => void action({ action: "generate_region", id: crypto.randomUUID(), prompt: changePrompt, confirmed: true, model: editConfig?.model, parameters: editConfig?.parameters, reservation: editConfig?.reservation, base_id: library?.accepted_id ?? null, object_ids: regionIds, ...(strokes ? { brush_strokes: strokes } : {}) }, "masked")}><Sparkles size={16}/>{maskedPending.current ? "Retry masked request" : "Generate selected change"}</button>
      </>}
    </>}
    {!asset && surfaceTarget && <IllustrationSurface target={surfaceTarget} width={view.width} height={view.height} status="Source render / No illustration selected"><Image unoptimized src={renderUrl} alt="Saved camera source render" fill sizes="100vw" style={{ objectFit: "contain" }}/></IllustrationSurface>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
