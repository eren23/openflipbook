"use client";
import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, Check, Upload, X } from "lucide-react";
import s from "./creator-workspace.module.css";

interface Preview { request_id: string; sha256: string; status: "preview" | "applied"; session_id: string; preview: { title: string; pages: number; places: number; objects: number; meshes: number; materials: number; views: number; illustrations: number; motion_studies?: number; clips?: number } }
const PENDING = "ofb_world_import_pending";
export default function WorldImporter({ onImported }: { onImported: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), pending = useRef<{ file: File; id: string } | null>(null), active = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [filename, setFilename] = useState("");
  async function request(url: string, init?: RequestInit): Promise<Preview> {
    const res = await fetch(url, { ...init, cache: "no-store" }); const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Import unavailable"); return data;
  }
  useEffect(() => {
    let cancelled = false; let id: string | null = null;
    try { id = localStorage.getItem(PENDING); } catch { /* Browser storage may be disabled. */ }
    if (id) void request(`/api/creator/imports/${encodeURIComponent(id)}`).then(data => { if (!cancelled && !pending.current) setPreview(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  async function inspect() {
    if (active.current || !pending.current) return;
    active.current = true; setBusy(true); setError(null);
    const draft = pending.current;
    try {
      await request("/api/creator/identity", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      try { localStorage.setItem(PENDING, draft.id); } catch { /* In-memory retry remains available. */ }
      const result = await request(`/api/creator/imports?request_id=${encodeURIComponent(draft.id)}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: draft.file });
      setPreview(result);
    } catch (e) { setError((e as Error).message); } finally { active.current = false; setBusy(false); }
  }
  async function apply() {
    if (active.current || !preview) return;
    active.current = true; setBusy(true); setError(null);
    try {
      const result = await request(`/api/creator/imports/${encodeURIComponent(preview.request_id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "apply", sha256: preview.sha256 }) });
      setPreview(result); onImported();
      try { localStorage.removeItem(PENDING); } catch { /* Committed receipt remains on the server. */ }
    } catch (e) { setError((e as Error).message); } finally { active.current = false; setBusy(false); }
  }
  return <>
    <button className={s.button} onClick={() => dialog.current?.showModal()}><ArchiveRestore size={16} />{preview?.status === "preview" ? "Resume import" : "Import World"}</button>
    <dialog ref={dialog} className={s.importDialog} aria-labelledby="world-import-title" onCancel={e => { if (busy) e.preventDefault(); }}>
      <header className={s.importHeader}><h2 id="world-import-title">Import World</h2><button className={s.icon} aria-label="Close import" title="Close import" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button></header>
      <label className={s.importFile}>World archive<input ref={input} type="file" accept=".zip,application/zip" disabled={busy} onChange={e => {
        const file = e.target.files?.[0]; if (!file) return; setPreview(null); setError(null); setFilename(file.name);
        if (file.size > 384 * 1024 * 1024) { pending.current = null; setError("World archive exceeds 384 MiB"); return; }
        pending.current = { file, id: crypto.randomUUID() }; void inspect();
      }} /></label>
      {busy && <p role="status">{preview ? "Saving private world..." : "Checking archive..."}</p>}
      {error && <p role="alert" className={s.error}>{error}</p>}
      {!preview && filename && error && pending.current && <button className={s.button} disabled={busy} onClick={() => void inspect()}><Upload size={16} />Retry inspection</button>}
      {preview && <>
        <h3 className={s.importTitle}>{preview.preview.title}</h3>
        <dl className={s.importCounts}>{(["pages", "places", "objects", "meshes", "materials", "views", "illustrations"] as const).map(key => <div key={key}><dt>{key}</dt><dd>{preview.preview[key]}</dd></div>)}</dl>
        {Boolean(preview.preview.motion_studies || preview.preview.clips) && <dl className={s.importCounts}><div><dt>motion studies</dt><dd>{preview.preview.motion_studies ?? 0}</dd></div><div><dt>clips</dt><dd>{preview.preview.clips ?? 0}</dd></div></dl>}
        <div className={s.importFooter}>{preview.status === "applied" ? <p role="status"><Check size={16} />Private world saved</p> : <button className={`${s.button} ${s.primary}`} disabled={busy} onClick={() => void apply()}><ArchiveRestore size={16} />Import as private world</button>}
          <button className={s.button} disabled={busy} onClick={() => dialog.current?.close()}>{preview.status === "applied" ? "Done" : "Cancel"}</button></div>
      </>}
    </dialog>
  </>;
}
