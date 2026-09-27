"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, LoaderCircle, Plus, RefreshCw, Replace, Sparkles, X } from "lucide-react";
import type { MeshJob, MeshSource, SavedMesh, MeshPlacement } from "@/lib/mesh-asset";
import type { MaterialAsset } from "@/lib/surface-material";
import MeshSourcePicker from "./mesh-source-picker";
import MeshImporter from "./mesh-importer";
import s from "./world-editor.module.css";
interface Config { enabled: boolean; reservation: number; model?: string; parameters?: Record<string, unknown>; reason?: string }
interface Props { sessionId: string; onPlace: (job: MeshPlacement) => void; kind?: "mesh" | "material"; onAssets?: (assets: MaterialAsset[]) => void; replacement?: { assetId: string; replace: (asset: MeshPlacement) => void } }

export default function MeshGenerator(props: Props) {
  return <MeshGeneratorPanel key={`${props.sessionId}:${props.kind ?? "mesh"}`} {...props}/>;
}

function MeshGeneratorPanel({sessionId, onPlace, kind = "mesh", onAssets, replacement}: Props) {
  const [prompt, setPrompt] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [jobs, setJobs] = useState<MeshJob[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [savedMeshes, setSavedMeshes] = useState<SavedMesh[]>([]);
  const [textConfig, setConfig] = useState<Config | null>(null), [imageConfig, setImageConfig] = useState<Config | null>(null);
  const [mode, setMode] = useState<"text" | "image" | "import">("text"), [source, setSource] = useState<MeshSource | null>(null);
  const image = kind === "mesh" && mode === "image", config = image ? imageConfig : textConfig;
  const importing = kind === "mesh" && mode === "import";
  const pending = useRef<Record<string, unknown> | null>(null);
  const material = kind === "material";
  const endpoint = `/api/world/${encodeURIComponent(sessionId)}/${material ? "materials" : "meshes"}`;
  const assetsRef = useRef(onAssets); assetsRef.current = onAssets;
  const call = useCallback(async (body?: unknown) => {
    const response = await fetch(endpoint, body ? {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {cache: "no-store"});
    const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || "3D generation unavailable"), {status: response.status}); return result;
  }, [endpoint]);
  const merge = useCallback((job: MeshJob) => setJobs(old => [job, ...old.filter(item => item.id !== job.id)].slice(0, 30)), []);
  useEffect(() => {
    let stopped = false;
    void call().then(data => {if (!stopped) {setConfig(data.capabilities); setImageConfig(data.image_capabilities ?? null); setJobs(data.jobs); setSavedMeshes(data.saved_meshes ?? []); assetsRef.current?.(data.assets ?? []);}}).catch(e => {if (!stopped) setError(e.message);});
    return () => {stopped = true;};
  }, [call]);
  const refresh = useCallback(async (id: string) => {
    try {const result = await call({action: "refresh", id}); merge(result.job); setError("");}
    catch (e) {setError((e as Error).message);}
  }, [call, merge]);
  const reload = useCallback(async () => {
    const data = await call(); setConfig(data.capabilities); setImageConfig(data.image_capabilities ?? null); setJobs(data.jobs); setSavedMeshes(data.saved_meshes ?? []); assetsRef.current?.(data.assets ?? []);
  }, [call]);
  const active = jobs.some(job => ["scheduled", "submitting", "queued", "running", "storing"].includes(job.status));
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const data = await call(); if (!stopped) { setConfig(data.capabilities); setImageConfig(data.image_capabilities ?? null); setJobs(data.jobs); setSavedMeshes(data.saved_meshes ?? []); assetsRef.current?.(data.assets ?? []); } }
      catch (e) { if (!stopped) setError((e as Error).message); }
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => {stopped = true; clearTimeout(timer);};
  }, [active, call]);
  async function generate() {
    if (!config?.enabled || !confirmed || busy || image && !source) return;
    pending.current ??= {action: "generate", id: crypto.randomUUID(), prompt, confirmed, model: config.model, parameters: config.parameters, reservation: config.reservation, ...(image ? { source_id: source!.id } : {})}; setBusy(true); setError("");
    try {const result = await call(pending.current); merge(result.job); pending.current = null; setConfirmed(false);}
    catch (e) {
      if ([400, 403, 404, 409, 413, 429].includes((e as Error & { status?: number }).status ?? 0)) pending.current = null;
      setError((e as Error).message);
    }
    finally {setBusy(false);}
  }
  const reservation = typeof pending.current?.reservation === "number" ? pending.current.reservation : config?.reservation ?? 0;
  return <section className={s.meshGenerator} aria-label={material ? "AI material generation" : "AI 3D generation"}>
    <div className={s.sectionHeading}><h2><Box size={16}/> {material ? "Generate material" : "Generate 3D object"}</h2><button title={`Refresh ${kind} jobs`} aria-label={`Refresh ${kind} jobs`} onClick={() => void reload().catch(e => setError(e.message))}><RefreshCw size={16}/></button></div>
    {!material && <div className={s.meshModes} role="group" aria-label="Mesh input mode">{(["text", "image", "import"] as const).map(value => <button key={value} aria-pressed={mode === value} disabled={busy || !!pending.current} onClick={() => { setMode(value); setConfirmed(false); }}>{value === "text" ? "Text" : value === "image" ? "Image" : "Import"}</button>)}</div>}
    {importing ? <MeshImporter sessionId={sessionId} onImported={asset => setSavedMeshes(old => [asset, ...old.filter(a => a.id !== asset.id)])}/> : <>
    {image && <MeshSourcePicker key={sessionId} sessionId={sessionId} selected={source} disabled={busy || !!pending.current} onSelect={value => { setSource(value); setConfirmed(false); if (!prompt && value) setPrompt(value.label.length >= 3 ? value.label : "Concept mesh"); }}/>}
    <label>{material ? "Material description" : image ? "Asset name" : "Object description"}<textarea aria-label={material ? "Material description" : image ? "Mesh asset name" : "3D object description"} value={prompt} maxLength={1024} disabled={busy || !!pending.current} onChange={e => setPrompt(e.target.value)} placeholder={material ? "Weathered limestone blocks, cool grey, fine pale mortar" : image ? "Timber bakery concept" : "A narrow timber bakery, teal tiled roof, stone chimney"}/></label>
    <div className={s.meshMeta}>{material ? "Seedream 5 Pro / base color" : image ? "Hunyuan3D v3 / image-conditioned mesh" : "Hunyuan3D v3 / textured mesh"}</div>
    {config?.enabled ? <label className={s.checkbox}><input type="checkbox" checked={confirmed} disabled={busy || !!pending.current} onChange={e => setConfirmed(e.target.checked)}/>Reserve ${reservation.toFixed(2)} for this generation</label> : <p role="status">{config?.reason || "Checking 3D generation availability..."}</p>}
    <button onClick={() => void generate()} disabled={!config?.enabled || !confirmed || prompt.trim().length < 3 || busy || active || image && !source}>{busy ? <LoaderCircle size={16}/> : <Sparkles size={16}/>} {pending.current ? `Retry saved ${kind} request` : `Generate ${kind}`}</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <ul className={s.meshJobs}>{jobs.map(job => <li key={job.id}>
      <strong>{job.prompt}</strong><span>{job.status.replaceAll("_", " ")}</span>
      {job.error && <p>{job.error}</p>}
      {job.status === "ready" && !material && <button onClick={() => onPlace(job)}><Plus size={16}/>Place in scene</button>}
      {job.status === "ready" && replacement && job.asset_id && job.asset_id !== replacement.assetId && <button onClick={() => replacement.replace(job)}><Replace size={16}/>Replace selected mesh</button>}
      {job.status === "storage_failed" && <button onClick={() => void refresh(job.id)}><RefreshCw size={16}/>Retry {kind} storage</button>}
      {["queued", "running", "submission_unknown"].includes(job.status) && <button title="Refresh generation status" aria-label="Refresh generation status" onClick={() => void refresh(job.id)}><RefreshCw size={16}/></button>}
      {!["ready", "failed", "cancelled"].includes(job.status) && <button title={job.status === "scheduled" ? "Cancel before submission" : `Discard ${kind} result (may still be billable)`} aria-label={`Cancel ${kind} job`} onClick={() => void call({action: "cancel", id: job.id}).then(data => merge(data.job)).catch(e => setError(e.message))}><X size={16}/></button>}
    </li>)}</ul>
    {!material && savedMeshes.some(asset => !jobs.some(job => job.asset_id === asset.id)) && <ul className={s.meshJobs} aria-label="Saved meshes">{savedMeshes.filter(asset => !jobs.some(job => job.asset_id === asset.id)).map(asset => <li key={asset.id}>
      <strong>{asset.prompt}</strong><span>{asset.imported ? "Imported GLB" : "Saved mesh"}</span>
      {!!asset.imported?.warnings.length && <details><summary>Validation warnings ({asset.imported.warnings.length})</summary><p>{asset.imported.warnings.join(", ")}</p></details>}
      <button onClick={() => onPlace({ asset_id: asset.id, prompt: asset.prompt })}><Plus size={16}/>Place in scene</button>
      {replacement && asset.id !== replacement.assetId && <button onClick={() => replacement.replace({ asset_id: asset.id, prompt: asset.prompt })}><Replace size={16}/>Replace selected mesh</button>}
    </li>)}</ul>}
  </section>;
}
