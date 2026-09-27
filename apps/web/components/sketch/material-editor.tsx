"use client";
import { useState } from "react";
import Image from "next/image";
import { ExternalLink, RotateCcw } from "lucide-react";
import type { BuildingSurface, PlaceSceneObject, SurfaceMaterial } from "@openflipbook/config";
import { materialSurfaces, type MaterialAsset } from "@/lib/surface-material";
import MeshGenerator from "./mesh-generator";
import s from "./world-editor.module.css";

export default function MaterialEditor({ sessionId, object, onChange }: { sessionId: string; object: PlaceSceneObject; onChange: (patch: Partial<PlaceSceneObject>) => void }) {
  return <SurfaceEditor sessionId={sessionId} surfaces={materialSurfaces(object)} materials={object.materials ?? {}} onChange={materials => onChange({ materials })}/>;
}

export function GroundMaterialEditor({ sessionId, binding, onChange }: { sessionId: string; binding: SurfaceMaterial | undefined; onChange: (binding: SurfaceMaterial | undefined) => void }) {
  return <SurfaceEditor sessionId={sessionId} surfaces={["floor"]} title="Ground material" materials={binding ? { floor: binding } : {}} onChange={materials => onChange(materials.floor)}/>;
}

function SurfaceEditor({ sessionId, surfaces, materials, onChange, title = "Surface materials" }: {
  sessionId: string; surfaces: BuildingSurface[]; materials: NonNullable<PlaceSceneObject["materials"]>;
  onChange: (materials: NonNullable<PlaceSceneObject["materials"]>) => void; title?: string;
}) {
  const [selection, setSurface] = useState<BuildingSurface>(surfaces[0] ?? "floor"), [assets, setAssets] = useState<MaterialAsset[]>([]);
  const surface = surfaces.includes(selection) ? selection : surfaces[0]!;
  const binding = materials[surface], base = `/api/world/${encodeURIComponent(sessionId)}/materials`;
  function assign(asset_id: string) {
    onChange({ ...materials, [surface]: { asset_id, tile_metres: binding?.tile_metres ?? 2, rotation: binding?.rotation ?? 0, roughness: binding?.roughness ?? 0.85 } });
  }
  function adjust(patch: Partial<SurfaceMaterial>) {
    if (binding) onChange({ ...materials, [surface]: { ...binding, ...patch } });
  }
  return <section aria-label={title}>
    <h2>{title}</h2>
    {surfaces.length > 1 && <label>Surface<select aria-label="Material surface" value={surface} onChange={e => setSurface(e.target.value as BuildingSurface)}>{surfaces.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
    <div className={s.materialSwatches} role="group" aria-label="Saved materials">
      {assets.map(asset => <button key={asset.id} title={asset.prompt} aria-label={`Use material: ${asset.prompt}`} aria-pressed={binding?.asset_id === asset.id} onClick={() => assign(asset.id)}><Image unoptimized src={`${base}/${encodeURIComponent(asset.id)}`} width={72} height={72} alt=""/><span>{asset.prompt}</span></button>)}
    </div>
    {binding && <>
      <div className={s.addRow}><a href={`${base}/${encodeURIComponent(binding.asset_id)}`} target="_blank" rel="noreferrer" title="Inspect saved texture" aria-label="Inspect saved texture"><ExternalLink size={18}/></a><button title="Remove surface material" aria-label="Remove surface material" onClick={() => { const next = { ...materials }; delete next[surface]; onChange(next); }}><RotateCcw size={16}/></button></div>
      <div className={s.fields}><label>Tile size (m)<input aria-label="Material tile size" type="number" min={0.1} max={20} step={0.1} value={binding.tile_metres} onChange={e => adjust({ tile_metres: Number(e.target.value) })}/></label><label>Rotation<input aria-label="Material rotation" type="number" min={-360} max={360} step={90} value={Math.round(binding.rotation * 180 / Math.PI)} onChange={e => adjust({ rotation: Number(e.target.value) * Math.PI / 180 })}/></label></div>
      <label>Roughness<input aria-label="Material roughness" type="range" min={0} max={1} step={0.05} value={binding.roughness} onChange={e => adjust({ roughness: Number(e.target.value) })}/></label>
      <span className={s.meshMeta}>Base color / tiling unverified</span>
    </>}
    <MeshGenerator sessionId={sessionId} kind="material" onPlace={job => { if (job.asset_id) assign(job.asset_id); }} onAssets={setAssets}/>
  </section>;
}
