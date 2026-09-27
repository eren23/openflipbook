"use client";
import { Plus, Trash2 } from "lucide-react";
import type { BuildingOpening, BuildingStructure, PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { buildingStair, parseBuildingStructure, storeyHeight } from "@/lib/building-structure";
import s from "./world-editor.module.css";
import RoomInspector from "./room-inspector";
import FootprintInspector from "./footprint-inspector";
import { footprintWalls } from "@/lib/building-footprint";

export default function BuildingInspector({object, definition, onChange, onError, onFloorSelect, activeFloorId}: {object: PlaceSceneObject; definition: PlaceSceneDefinition; onChange: (patch: Partial<PlaceSceneObject>) => void; onError: (message: string) => void; onFloorSelect: (id: string) => void; activeFloorId?: string | undefined}) {
  const structure = object.structure!;
  const stair = buildingStair(object);
  const update = (patch: Partial<BuildingStructure>) => onChange({structure: {...structure, ...patch}});
  const updateStair = (patch: Partial<NonNullable<BuildingStructure["stair"]>>) => {
    try {
      const next = parseBuildingStructure({ ...object, structure: { ...structure, stair: { id: structure.stair?.id ?? crypto.randomUUID(), x: stair.x, z: stair.z, direction: stair.direction, ...patch } } });
      onChange({ structure: next });
    } catch (error) { onError((error as Error).message); }
  };
  const openingFields = (opening: BuildingOpening, label: string, change: (patch: Partial<BuildingOpening>) => void, door = false) => <>
    <label>Wall<select aria-label={`${label} wall`} value={structure.footprint ? opening.wall_id : opening.side} onChange={e => {
      if (!structure.footprint) change({side: e.target.value as BuildingOpening["side"]});
      else { const wall = footprintWalls(object).find(w => w.id === e.target.value)!; change({ side: wall.side, wall_id: wall.id, offset: (wall.low + wall.high) / 2 }); }
    }}>{structure.footprint ? footprintWalls(object).map((wall, i) => <option key={wall.id} value={wall.id}>{wall.side} / wall {i + 1}</option>) : ["north","east","south","west"].map(side=><option key={side} value={side}>{side}</option>)}</select></label>
    {!door && <label>Floor<select aria-label={`${label} floor`} value={opening.floor} onChange={e=>change({floor:Number(e.target.value)})}>{structure.floors.map((floor,i)=><option key={floor.id} value={i}>{floor.label}</option>)}</select></label>}
    <div className={s.fields}>{(["offset","width","height",...(!door ? ["sill" as const] : [])] as const).map(key=><label key={key}>{key} (m)<input aria-label={`${label} ${key}`} type="number" step={0.1} value={opening[key]} onChange={e=>change({[key]:Number(e.target.value)})}/></label>)}</div>
  </>;
  function floors(count: number) {
    const next = structure.floors.slice(0,count);
    while (next.length<count) next.push({id:crypto.randomUUID(),label:"Upper floor"});
    const { stair: savedStair, ...rest } = structure;
    onChange({height: object.asset_id ? object.height : Number((storeyHeight(object)*count+structure.roof_height).toFixed(4)), structure:{...rest,...(object.asset_id ? { roof_height: Math.max(0.3, Math.min(4, object.height - 3.2 * count)) } : {}),...(count === 2 && savedStair ? { stair: savedStair } : {}),floors:next,windows:structure.windows.filter(w=>w.floor<count)}});
  }
  function addWindow() {
    for (let floor=0;floor<structure.floors.length;floor++) for(const wall of footprintWalls(object)) for(const offset of [(wall.low + wall.high) / 2, -2, 2]) {
      const window:BuildingOpening={id:crypto.randomUUID(),side:wall.side,...(structure.footprint ? { wall_id: wall.id } : {}),offset,width:1.2,height:1.1,sill:1.1,floor};
      try {const next=parseBuildingStructure({...object,structure:{...structure,windows:[...structure.windows,window]}}); onChange({structure:next});return;} catch { /* Find an opening that fits the wall. */ }
    }
    onError("No free window opening. Adjust the existing windows or building dimensions.");
  }
  return <section aria-label="Building architecture">
    <h2>Architecture</h2>
    <FootprintInspector key={`${object.id}:${object.width}:${object.depth}:${JSON.stringify(structure)}`} object={object} definition={definition} onChange={onChange} onError={onError}/>
    <label>Floors<select aria-label="Building floors" value={structure.floors.length} onChange={e=>floors(Number(e.target.value))}><option value={1}>One floor</option><option value={2}>Two floors with stairs</option></select></label>
    <div className={s.fields}><label>Wall thickness (m)<input aria-label="Wall thickness" type="number" min={0.15} max={0.5} step={0.05} value={structure.wall_thickness} onChange={e=>update({wall_thickness:Number(e.target.value)})}/></label><label>Roof height (m)<input aria-label="Building roof height" type="number" min={0.3} max={4} step={0.1} value={structure.roof_height} onChange={e=>update({roof_height:Number(e.target.value)})}/></label></div>
    {structure.floors.map((floor,i)=><label key={floor.id}>Floor {i+1} name<input aria-label={`Floor ${i+1} name`} value={floor.label} maxLength={100} onChange={e=>update({floors:structure.floors.map(f=>f.id===floor.id?{...f,label:e.target.value}:f)})}/></label>)}
    {structure.floors.length === 2 && <fieldset><legend>Stairs</legend>
      <div className={s.fields}>{(["x", "z"] as const).map(axis => <label key={axis}>Centre {axis} (m)<input aria-label={`Stair centre ${axis}`} type="number" step={0.1} value={Number(stair[axis].toFixed(4))} onChange={e => updateStair({ [axis]: Number(e.target.value) })}/></label>)}</div>
      <label>Climb toward<select aria-label="Stair climbing direction" value={stair.direction} onChange={e => updateStair({ direction: e.target.value as BuildingOpening["side"] })}>{["north", "east", "south", "west"].map(side => <option key={side} value={side}>{side}</option>)}</select></label>
    </fieldset>}
    <RoomInspector key={object.id} object={object} definition={definition} activeFloorId={activeFloorId} onChange={onChange} onError={onError} onFloorSelect={onFloorSelect}/>
    <h2>Doorway</h2>
    {openingFields(structure.door,"Doorway",patch=>update({door:{...structure.door,...patch}}),true)}
    <div className={s.sectionHeading}><h2>Windows</h2><button title="Add window" aria-label="Add window" disabled={structure.windows.length>=16} onClick={addWindow}><Plus size={16}/></button></div>
    {structure.windows.map((window,i)=><div key={window.id}>
      <div className={s.sectionHeading}><h3>Window {i+1}</h3><button title={`Remove window ${i+1}`} aria-label={`Remove window ${i+1}`} onClick={()=>update({windows:structure.windows.filter(w=>w.id!==window.id)})}><Trash2 size={16}/></button></div>
      {openingFields(window,`Window ${i+1}`,patch=>update({windows:structure.windows.map(w=>w.id===window.id?{...w,...patch}:w)}))}
    </div>)}
  </section>;
}
