"use client";
import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { MeshSource } from "@/lib/mesh-asset";
import s from "./world-editor.module.css";

export default function MeshSourcePicker({ sessionId, selected, disabled, onSelect }: {
  sessionId: string; selected: MeshSource | null; disabled: boolean; onSelect: (source: MeshSource | null) => void;
}) {
  const [sources, setSources] = useState<MeshSource[]>([]), [nodes, setNodes] = useState<{ id: string; label: string }[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null), alive = useRef(true);
  const endpoint = `/api/world/${encodeURIComponent(sessionId)}/meshes/sources`;
  useEffect(() => {
    alive.current = true;
    void fetch(endpoint, { cache: "no-store" }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Concept library unavailable");
      if (alive.current) { setSources(data.sources); setNodes(data.nodes); }
    }).catch(e => { if (alive.current) setError(e.message); });
    return () => { alive.current = false; };
  }, [endpoint]);
  async function save(input: unknown) {
    setBusy(true); setError(""); onSelect(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Concept image could not be saved");
      if (alive.current) { setSources(old => [data.source, ...old.filter(s => s.id !== data.source.id)]); onSelect(data.source); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  async function upload(image: File) {
    if (image.size > 12 * 1024 * 1024) { setError("Concept image exceeds 12 MiB"); return; }
    setBusy(true); setError(""); onSelect(null);
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Image could not be read")); reader.readAsDataURL(image); });
      if (alive.current) await save({ data_url: data, label: image.name });
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className={s.meshSource}>
    <label>Concept image<select aria-label="Concept image" disabled={disabled || busy} value={selected ? `source:${selected.id}` : ""} onChange={e => {
      const [kind, id] = e.target.value.split(":");
      if (kind === "source") { const source = sources.find(s => s.id === id); if (source) onSelect(source); }
      if (kind === "node") void save({ node_id: id });
    }}><option value="" disabled>Choose an image</option>
      <optgroup label="Saved concepts">{sources.map(source => <option key={source.id} value={`source:${source.id}`}>{source.label}</option>)}</optgroup>
      <optgroup label="World images and accepted sketches">{nodes.map(node => <option key={node.id} value={`node:${node.id}`}>{node.label}</option>)}</optgroup>
    </select></label>
    <input ref={file} aria-label="Upload concept file" type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={disabled || busy} onChange={e => { const image = e.target.files?.[0]; e.target.value = ""; if (image) void upload(image); }}/>
    <button disabled={disabled || busy} onClick={() => file.current?.click()}><Upload size={16}/>{busy ? "Saving concept..." : "Upload concept"}</button>
    {selected && <>
      {/* Private creator route; never a public storage URL. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${endpoint}/${selected.id}`} alt={selected.label} width={selected.width} height={selected.height}/>
      <span className={s.meshMeta}>{selected.origin.kind === "imported_reference" ? "Imported reference" : "Saved world image"} / {selected.width} x {selected.height}</span>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
