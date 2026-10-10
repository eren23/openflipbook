"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Download, Footprints, Focus, Map, X, ZoomIn, ZoomOut } from "lucide-react";
import type { PlaceNetwork } from "@openflipbook/config";
import { connectedMapRoute, connectedMapWalkPoint, connectedWorldMap } from "@/lib/connected-world-map";
import type { WalkPose } from "@/lib/walk-position";
import s from "./connected-world-map.module.css";

interface Props {
  network: PlaceNetwork; placeId: string; selectedObject?: string | null; walkPose: WalkPose | null;
  onClose: () => void; onOpenPlace: (placeId: string, objectId: string | null) => void;
  onWalk: () => void; canWalk: boolean; assetBaseUrl?: string | undefined; materialBaseUrl?: string | undefined;
}

export default function ConnectedWorldMap({ network, placeId, selectedObject, walkPose, onClose, onOpenPlace, onWalk, canWalk, assetBaseUrl, materialBaseUrl }: Props) {
  const map = useMemo(() => {
    try { return { value: connectedWorldMap(network, placeId), error: "" }; }
    catch (e) { return { value: null, error: (e as Error).message }; }
  }, [network, placeId]);
  const [selection, setSelection] = useState({ place: placeId, object: selectedObject ?? null });
  const [camera, setCamera] = useState<{ x: number; z: number; width: number; depth: number } | null>(null);
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState("");
  const [download, setDownload] = useState<{ url: string; filename: string; bytes: number } | null>(null);
  const exportAbort = useRef<AbortController | null>(null), downloadUrl = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; camera: NonNullable<typeof camera> } | null>(null);
  useEffect(() => { const d = dialog.current!; d.showModal(); return () => { d.close(); exportAbort.current?.abort(); if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); }; }, []);
  const world = map.value;
  const fitted = { x: -4, z: -4, width: (world?.width ?? 40) + 8, depth: (world?.depth ?? 40) + 8 };
  const frame = camera ?? fitted;
  const marker = world && connectedMapWalkPoint(world, walkPose);
  const from = marker?.place_id ?? placeId;
  const route = world && connectedMapRoute(world, from, selection.place);
  const chosen = world?.chunks.find(c => c.scene.place_id === selection.place);
  const chosenObject = chosen?.scene.definition.objects.find(o => o.id === selection.object);
  const name = (id: string) => world?.chunks.find(c => c.scene.place_id === id)?.scene.definition.label ?? id;
  const textSize = Math.max(world?.width ?? 40, world?.depth ?? 40) / 75;
  const scale = (world?.width ?? 40) >= 40 ? 10 : 5;
  const choose = (place: string, object: string | null = null) => setSelection({ place, object });
  function zoom(factor: number) {
    const width = Math.max(fitted.width / 8, Math.min(fitted.width * 2, frame.width * factor));
    const ratio = width / frame.width;
    setCamera({ x: frame.x + (frame.width - width) / 2, z: frame.z + frame.depth * (1 - ratio) / 2, width, depth: frame.depth * ratio });
  }
  async function exportWorld() {
    if (exporting || !world) return;
    const abort = new AbortController(); exportAbort.current = abort; setExporting(true); setExportError("");
    try {
      const { exportConnectedWorld } = await import("./connected-world-export");
      const result = await exportConnectedWorld({ network, rootPlaceId: placeId, ...(assetBaseUrl ? { assetBaseUrl } : {}), ...(materialBaseUrl ? { materialBaseUrl } : {}), signal: abort.signal });
      if (abort.signal.aborted) return;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      const url = URL.createObjectURL(result.blob); downloadUrl.current = url;
      setDownload({ url, filename: result.filename, bytes: result.blob.size });
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = result.filename; anchor.click();
    } catch (e) { if (!abort.signal.aborted) setExportError((e as Error).message); }
    finally { if (!abort.signal.aborted) setExporting(false); }
  }
  return <dialog ref={dialog} className={s.dialog} aria-label="World map" onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={e => { if (e.key !== "Escape") e.stopPropagation(); }}>
    <header className={s.header}><div><h2><Map size={20}/>World map</h2><p>{world ? `${world.width.toFixed(0)} × ${world.depth.toFixed(0)} m · ${world.chunks.length} places · ${world.buildingCount} buildings` : "Saved connected places"}</p></div><button aria-label="Close world map" onClick={onClose}><X size={20}/></button></header>
    {map.error ? <p role="alert" className={s.error}>{map.error}</p> : world && <div className={s.body}>
      <section className={s.mapPane} aria-label="District overview">
        <div className={s.tools}><button aria-label="Zoom in world map" onClick={() => zoom(1 / 1.5)}><ZoomIn size={18}/></button><button aria-label="Zoom out world map" onClick={() => zoom(1.5)}><ZoomOut size={18}/></button><button onClick={() => setCamera(null)}><Focus size={17}/>Fit world</button><span>Drag to pan</span></div>
        <svg ref={svg} data-testid="connected-world-map" className={s.map} viewBox={`${frame.x} ${frame.z} ${frame.width} ${frame.depth}`} role="group" aria-label={`Spatial map of ${world.chunks.length} connected places`} onWheel={e => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15); }}
          onPointerDown={e => { if ((e.target as Element).closest("[data-map-select]")) return; drag.current = { x: e.clientX, y: e.clientY, camera: frame }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { const start = drag.current, bounds = svg.current?.getBoundingClientRect(); if (!start || !bounds || !bounds.width || !bounds.height) return; const unit = Math.min(bounds.width / start.camera.width, bounds.height / start.camera.depth); setCamera({ ...start.camera, x: start.camera.x - (e.clientX - start.x) / unit, z: start.camera.z - (e.clientY - start.y) / unit }); }}
          onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { drag.current = null; }}>
          <defs><pattern id="connected-world-grid" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M 5 0 L 0 0 0 5" fill="none" stroke="#aabbb0" strokeWidth=".05"/></pattern></defs>
          <rect x={-200} y={-200} width={600} height={600} fill="url(#connected-world-grid)"/>
          {world.chunks.map((c, i) => <g key={c.scene.place_id}>
            <rect data-map-select="place" role="button" tabIndex={0} aria-label={`Select place ${c.scene.definition.label}`} aria-pressed={selection.place === c.scene.place_id} x={c.x} y={c.z} width={c.scene.definition.width} height={c.scene.definition.depth} fill={["#e4ecdf", "#e4eee9", "#eee8db", "#e6e9f1"][i % 4]} stroke={selection.place === c.scene.place_id ? "#267861" : "#768d7d"} strokeWidth={selection.place === c.scene.place_id ? .24 : .1} onClick={() => choose(c.scene.place_id)} onKeyDown={e => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); choose(c.scene.place_id); } }}/>
            <text x={c.x + .8} y={c.z + textSize * 1.45} fontSize={textSize} fill="#355246" className={s.placeLabel}>{c.scene.definition.label}</text>
            <circle cx={c.x + c.scene.definition.entrance.x} cy={c.z + c.scene.definition.entrance.z} r={.35} fill="none" stroke="#77735b" strokeWidth={.15}><title>{c.scene.definition.label} entrance</title></circle>
          </g>)}
          {world.objects.map(({ place_id, object, x, z, outline, door }) => <g key={`${place_id}:${object.id}`}>
            <polygon data-map-select="object" role="button" tabIndex={0} aria-label={`Select ${object.label} in ${name(place_id)}`} aria-pressed={selection.place === place_id && selection.object === object.id} points={outline.map(p => `${p.x},${p.z}`).join(" ")} fill={object.color} fillOpacity={object.kind === "path" ? .5 : .82} stroke={selection.place === place_id && selection.object === object.id ? "#122f27" : "#69766a"} strokeWidth={selection.place === place_id && selection.object === object.id ? .26 : .1} onClick={() => choose(place_id, object.id)} onKeyDown={e => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); choose(place_id, object.id); } }}/>
            {["building", "house", "tavern"].includes(object.kind) && <text x={x} y={z} fontSize={textSize * .86} textAnchor="middle" dominantBaseline="middle" className={s.objectLabel}>{object.label}</text>}
            {door && <circle cx={door.x} cy={door.z} r={.32} fill="#fff9db" stroke="#635e38" strokeWidth={.12}><title>{object.label} door</title></circle>}
          </g>)}
          {world.portals.map(p => { const index = route?.portals.findIndex(r => r.connection.id === p.connection.id) ?? -1; return <g key={p.connection.id}>
            <line x1={p.from.x} y1={p.from.z} x2={p.to.x} y2={p.to.z} stroke="#fafdf7" strokeWidth={.45}/><line x1={p.from.x} y1={p.from.z} x2={p.to.x} y2={p.to.z} stroke="#287b70" strokeWidth={.2}><title>{name(p.connection.a.place_id)} ↔ {name(p.connection.b.place_id)} · {p.connection.width} m opening</title></line>
            {index >= 0 && <g><circle cx={p.x} cy={p.z} r={textSize * .85} fill="#1f6c57" stroke="#fff" strokeWidth={.12}/><text x={p.x} y={p.z} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={textSize}>{index + 1}</text></g>}
          </g>; })}
          {marker && <g data-testid="world-map-walk-marker" data-place={marker.place_id} data-x={marker.x} data-z={marker.z} transform={`translate(${marker.x} ${marker.z}) rotate(${-marker.yaw * 180 / Math.PI})`}><circle r={.65} fill="#3075b2" stroke="#fff" strokeWidth={.18}/><path d="M -.35 -.4 L 0 -1.1 .35 -.4" fill="#3075b2" stroke="#fff" strokeWidth={.12}/><title>Current walking position in {name(marker.place_id)}</title></g>}
          <g transform={`translate(${world.width - scale - 1} ${world.depth + 2})`}><path d={`M 0 -.25 V .25 M 0 0 H ${scale} M ${scale} -.25 V .25`} fill="none" stroke="#405d50" strokeWidth={.12}/><text x={scale / 2} y={1.3} fontSize={textSize * .9} textAnchor="middle" fill="#405d50">{scale} m</text></g>
          <g transform="translate(-2 -1)"><path d="M 0 2 V -1 M -.4 -.4 L 0 -1 .4 -.4" stroke="#405d50" strokeWidth={.12} fill="none"/><text x="0" y="-1.5" textAnchor="middle" fontSize={textSize}>N</text></g>
        </svg>
        <div className={s.legend}><span><i className={s.walkDot}/>Walking position</span><span><i className={s.doorDot}/>Building door</span><span><i className={s.portalDot}/>Boundary opening</span><span>5 m grid</span></div>
      </section>
      <aside className={s.details}>
        <h3>Places</h3><div className={s.places}>{world.chunks.map(c => <button key={c.scene.place_id} aria-pressed={selection.place === c.scene.place_id} onClick={() => choose(c.scene.place_id)}><span>{c.scene.definition.label}</span><small>{c.scene.definition.width} × {c.scene.definition.depth} m{marker?.place_id === c.scene.place_id ? " · You are here" : ""}</small></button>)}</div>
        <section aria-label="Map selection"><h3>{chosenObject?.label ?? chosen?.scene.definition.label}</h3><p>{chosenObject ? `${chosenObject.kind}${chosenObject.structure ? ` · ${chosenObject.structure.floors.length} floor${chosenObject.structure.floors.length === 1 ? "" : "s"}` : ""}` : `${chosen?.scene.definition.objects.filter(o => ["building", "house", "tavern"].includes(o.kind)).length ?? 0} buildings`}</p><button className={s.primary} onClick={() => onOpenPlace(selection.place, selection.object)}>Edit selection<ArrowRight size={16}/></button></section>
        <section aria-label="Walking connections"><h3>Walk from {name(from)}</h3>{route ? route.portals.length ? <><ol>{route.portals.map((p, i) => <li key={p.connection.id}>{name(route.places[i + 1]!)}<small>{p.connection.width} m boundary opening</small></li>)}</ol><p>Follow the numbered openings. Choose a clear path around buildings.</p></> : <p>{chosenObject ? `Explore ${chosenObject.label} in this place.` : "You are in the selected place."}</p> : <p>No connected route to this place.</p>}
          <button disabled={!canWalk} onClick={onWalk}><Footprints size={17}/>Continue walking</button></section>
        <section className={s.export}><button disabled={exporting} onClick={() => void exportWorld()}><Download size={17}/>{exporting ? "Preparing world…" : "Export full world (.glb)"}</button><p>Open the saved district in Blender.</p>{exporting && <button onClick={() => { exportAbort.current?.abort(); setExporting(false); }}>Cancel export</button>}{exportError && <p role="alert" className={s.error}>{exportError}</p>}{download && <a href={download.url} download={download.filename}>Download again · {(download.bytes / 1024 / 1024).toFixed(1)} MB</a>}</section>
      </aside>
    </div>}
  </dialog>;
}
