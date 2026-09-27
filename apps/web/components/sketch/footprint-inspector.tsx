"use client";
import { useState } from "react";
import { Check, Pencil, Plus, Scissors, X } from "lucide-react";
import type { BuildingStructure, PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { footprintWalls, openingWall, rectangleOutline } from "@/lib/building-footprint";
import { parseBuildingStructure } from "@/lib/building-structure";
import { validateFloorPlacements } from "@/lib/floor-placement";
import { validateRoomCirculation } from "@/lib/room-circulation";
import s from "./world-editor.module.css";

export default function FootprintInspector({ object, definition, onChange, onError }: { object: PlaceSceneObject; definition: PlaceSceneDefinition; onChange: (patch: Partial<PlaceSceneObject>) => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState<BuildingStructure | null>(null);
  const [selected, setSelected] = useState(1), [span, setSpan] = useState(3), [depth, setDepth] = useState(2), [offset, setOffset] = useState(0);
  function begin() {
    const source = object.structure!, ring = source.footprint ?? rectangleOutline().map(p => ({ ...p, id: crypto.randomUUID() }));
    const bind = (opening: BuildingStructure["door"]) => ({ ...opening, wall_id: source.footprint ? openingWall(object, opening).id : ring[["north", "east", "south", "west"].indexOf(opening.side)]!.id });
    setDraft({ ...source, footprint: ring, door: bind(source.door), windows: source.windows.map(bind) });
  }
  function recess() {
    if (!draft?.footprint) return;
    try {
      const walls = footprintWalls({ ...object, structure: draft }), wall = walls[selected]!;
      if (!wall || ![span, depth, offset].every(Number.isFinite) || span < 0.6 || depth < 0.6 || offset - span / 2 <= wall.low + 0.6 || offset + span / 2 >= wall.high - 0.6) throw new Error("Recess needs at least 0.6 m of wall at each end");
      if (draft.footprint.length + 4 > 24) throw new Error("Footprint is limited to 24 corners");
      const forward = wall.side === "north" || wall.side === "east" ? 1 : -1;
      const inward = wall.side === "north" || wall.side === "west" ? 1 : -1;
      const point = (along: number, across: number) => ({ id: crypto.randomUUID(), x: (wall.horizontal ? along : across) / object.width, z: (wall.horizontal ? across : along) / object.depth });
      const a = offset - forward * span / 2, b = offset + forward * span / 2;
      const ring = [...draft.footprint];
      ring.splice(selected + 1, 0, point(a, wall.edge), point(a, wall.edge + inward * depth), point(b, wall.edge + inward * depth), point(b, wall.edge));
      setDraft({ ...draft, footprint: ring });
    } catch (error) { onError((error as Error).message); }
  }
  function apply() {
    try {
      const next = { ...object, structure: parseBuildingStructure({ ...object, structure: draft! }) };
      const candidate = { ...definition, objects: definition.objects.map(o => o.id === object.id ? next : o) };
      validateFloorPlacements(candidate); validateRoomCirculation(candidate);
      onChange({ structure: next.structure }); setDraft(null);
    }
    catch (error) { onError((error as Error).message); }
  }
  function trimCorner() {
    if (!draft?.footprint) return;
    try {
      const ring = [...draft.footprint], index = (selected + 1) % ring.length;
      const p = ring[selected]!, q = ring[index]!, r = ring[(index + 1) % ring.length]!;
      const ex = Math.sign(q.x - p.x), ez = Math.sign(q.z - p.z), fx = Math.sign(r.x - q.x), fz = Math.sign(r.z - q.z);
      const incoming = Math.abs(q.x - p.x) * object.width + Math.abs(q.z - p.z) * object.depth;
      const outgoing = Math.abs(r.x - q.x) * object.width + Math.abs(r.z - q.z) * object.depth;
      if (ex * fz - ez * fx !== 1 || ![span, depth].every(Number.isFinite) || span < 0.6 || depth < 0.6 || span > incoming - 0.6 || depth > outgoing - 0.6 || ring.length + 2 > 24) throw new Error("Corner trim needs a convex corner and at least 0.6 m of remaining wall");
      const a = { id: crypto.randomUUID(), x: q.x - ex * span / object.width, z: q.z - ez * span / object.depth };
      const b = { id: crypto.randomUUID(), x: a.x + fx * depth / object.width, z: a.z + fz * depth / object.depth };
      const c = { ...q, x: q.x + fx * depth / object.width, z: q.z + fz * depth / object.depth };
      ring.splice(index, 1, a, b, c); setDraft({ ...draft, footprint: ring });
    } catch (error) { onError((error as Error).message); }
  }
  const scaleX = 100 * object.width / Math.max(object.width, object.depth), scaleZ = 100 * object.depth / Math.max(object.width, object.depth);
  return <fieldset><legend>Footprint</legend>
    {!draft ? <button onClick={begin}><Pencil size={16}/> Edit outline</button> : <>
      <svg viewBox="-60 -60 120 120" className={s.footprintPreview} role="img" aria-label="Draft building footprint">
        <polygon points={draft.footprint!.map(p => `${p.x * scaleX},${p.z * scaleZ}`).join(" ")} fill="#dce8e5" stroke="#237b6d" strokeWidth={1}/>
        {draft.footprint!.map((p, i) => <g key={p.id}><circle cx={p.x * scaleX} cy={p.z * scaleZ} r={1.5} fill="#ad3845"/><text x={p.x * scaleX + 2} y={p.z * scaleZ - 2} fontSize={5} fill="currentColor">{i + 1}</text></g>)}
      </svg>
      <div className={s.footprintCorners}>{draft.footprint!.map((p, i) => <div key={p.id} className={s.fields}>{(["x", "z"] as const).map(axis => <label key={axis}>Corner {i + 1} {axis} (m)<input aria-label={`Footprint corner ${i + 1} ${axis}`} type="number" step={0.1} value={Number((p[axis] * (axis === "x" ? object.width : object.depth)).toFixed(4))} onChange={e => setDraft({ ...draft, footprint: draft.footprint!.map(v => v.id === p.id ? { ...v, [axis]: Number(e.target.value) / (axis === "x" ? object.width : object.depth) } : v) })}/></label>)}</div>)}</div>
      <label>Recess wall<select aria-label="Recess wall" value={selected} onChange={e => { setSelected(Number(e.target.value)); setOffset(0); }}>{draft.footprint!.map((p, i) => <option key={p.id} value={i}>Wall {i + 1}</option>)}</select></label>
      <div className={s.fields}>{([["Width", span, setSpan], ["Depth", depth, setDepth], ["Offset", offset, setOffset]] as const).map(([name, value, set]) => <label key={name}>{name} (m)<input aria-label={`Recess ${name.toLowerCase()}`} type="number" step={0.1} value={value} onChange={e => set(Number(e.target.value))}/></label>)}</div>
      <button aria-label="Add footprint recess" disabled={draft.footprint!.length >= 24} onClick={recess}><Plus size={16}/> Add recess</button>
      <button title="Trim the corner at the end of the selected wall" disabled={draft.footprint!.length > 22} onClick={trimCorner}><Scissors size={16}/> Trim corner</button>
      <div className={s.sectionHeading}><button onClick={() => setDraft(null)}><X size={16}/> Cancel outline</button><button onClick={apply}><Check size={16}/> Apply outline</button></div>
    </>}
  </fieldset>;
}
