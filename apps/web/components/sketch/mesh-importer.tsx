"use client";
import { useEffect, useRef, useState } from "react";
import { FileBox, Upload } from "lucide-react";
import { MAX_MESH_BYTES, type SavedMesh } from "@/lib/mesh-asset";
import s from "./world-editor.module.css";

export default function MeshImporter({ sessionId, onImported }: { sessionId: string; onImported: (asset: SavedMesh) => void }) {
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function upload() {
    if (!file || busy) return;
    if (file.size > MAX_MESH_BYTES) { setError("GLB exceeds 80 MiB"); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch(`/api/world/${encodeURIComponent(sessionId)}/meshes/import`, { method: "POST", headers: { "Content-Type": "model/gltf-binary", "X-Mesh-Filename": encodeURIComponent(file.name) }, body: file, signal: abort.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Mesh import failed");
      if (!abort.signal.aborted) { onImported(data.asset); setSaved(true); }
    } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <div className={s.meshSource}>
    <input ref={input} type="file" accept=".glb,model/gltf-binary" aria-label="GLB file" hidden disabled={busy} onChange={e => { setFile(e.target.files?.[0] ?? null); setError(""); setSaved(false); }}/>
    <button disabled={busy} onClick={() => input.current?.click()}><FileBox size={16}/>Choose GLB</button>
    {file && <span className={s.meshMeta}>{file.name} / {(file.size / 1024 / 1024).toFixed(2)} MiB</span>}
    <button disabled={!file || busy || saved} onClick={() => void upload()}><Upload size={16}/>{busy ? "Importing..." : error ? "Retry GLB import" : "Import GLB"}</button>
    {busy && <p role="status">Uploading and validating GLB...</p>}
    {saved && <p role="status">GLB validated and saved</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
