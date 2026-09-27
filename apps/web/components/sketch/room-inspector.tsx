"use client";
import { useState } from "react";
import { Columns2, Plus, Trash2 } from "lucide-react";
import type { PlaceSceneDefinition, PlaceSceneObject, RoomLayout } from "@openflipbook/config";
import { parsePlaceScene } from "@/lib/place-scene";
import { replaceRoomLayout, roomLayoutGeometry } from "@/lib/room-layout";
import s from "./world-editor.module.css";

export default function RoomInspector({ object, definition, onChange, onError, onFloorSelect, activeFloorId }: {
  object: PlaceSceneObject; definition: PlaceSceneDefinition; onChange: (patch: Partial<PlaceSceneObject>) => void;
  onError: (message: string) => void; onFloorSelect: (id: string) => void;
  activeFloorId?: string | undefined;
}) {
  const [roomId, setRoomId] = useState(""), [wallId, setWallId] = useState(""), [axis, setAxis] = useState<"x" | "z">("x");
  const structure = object.structure!, floorIndex = Math.max(0, structure.floors.findIndex(f => f.id === activeFloorId)), floor = structure.floors[floorIndex]!;
  const { rooms, partitions } = roomLayoutGeometry(object, floorIndex), room = rooms.find(r => r.id === roomId) ?? rooms[0], wall = partitions.find(p => p.node.id === wallId) ?? partitions[0];
  function candidate(layout: RoomLayout | undefined) {
    const nextFloor = { ...floor }; if (layout) nextFloor.layout = layout; else delete nextFloor.layout;
    const next = { ...object, structure: { ...structure, floors: structure.floors.map(f => f.id === floor.id ? nextFloor : f) } };
    parsePlaceScene({ ...definition, objects: definition.objects.map(o => o.id === object.id ? next : o) });
    return next;
  }
  function apply(layout: RoomLayout | undefined) {
    try { onChange(candidate(layout)); onFloorSelect(floor.id); } catch (e) { onError((e as Error).message); }
  }
  function split() {
    if (!floor.layout || !room) return;
    const middle = axis === "x" ? (room.x1 + room.x2) / 2 : (room.z1 + room.z2) / 2;
    const offset = axis === "x" ? (room.z1 + room.z2) / 2 : (room.x1 + room.x2) / 2;
    const node: Extract<RoomLayout, { type: "split" }> = { type: "split", id: crypto.randomUUID(), axis, position: middle,
      door: { id: crypto.randomUUID(), offset, width: 1.2, height: 2.2 },
      a: { type: "room", id: room.id, label: room.label }, b: { type: "room", id: crypto.randomUUID(), label: "New room" } };
    let reason = "No valid split fits this room";
    const positions = [...new Set([...[0, 1.5, -1, 1, -1.5, 2, -2].map(shift => middle + shift), ...(room.cells ?? []).map(c => axis === "x" ? (c.x1 + c.x2) / 2 : (c.z1 + c.z2) / 2)])];
    const offsets = [...new Set([offset, ...(room.cells ?? []).map(c => axis === "x" ? (c.z1 + c.z2) / 2 : (c.x1 + c.x2) / 2)])];
    for (const position of positions) for (const doorOffset of offsets) {
      const layout = replaceRoomLayout(floor.layout, room.id, { ...node, position, door: { ...node.door, offset: doorOffset } });
      try { const next = candidate(layout); onChange(next); onFloorSelect(floor.id); setWallId(node.id); setRoomId(node.b.id); return; }
      catch (e) { reason = (e as Error).message; }
    }
    onError(`Cannot split this room: ${reason}`);
  }
  const editWall = (patch: Partial<Extract<RoomLayout, { type: "split" }>>) => {
    if (wall && floor.layout) apply(replaceRoomLayout(floor.layout, wall.node.id, { ...wall.node, ...patch }));
  };
  return <section aria-label="Room layout">
    <h2>Rooms</h2>
    <label>Floor<select aria-label="Room layout floor" value={floor.id} onChange={e => { setRoomId(""); setWallId(""); onFloorSelect(e.target.value); }}>{structure.floors.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
    {!floor.layout ? <button title="Create room layout" aria-label="Create room layout" onClick={() => apply({ type: "room", id: crypto.randomUUID(), label: "Main room" })}><Plus size={16} />Create room layout</button> : <>
      <label>Room<select aria-label="Selected room" value={room?.id ?? ""} onChange={e => setRoomId(e.target.value)}>{rooms.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
      {room && <label>Name<input aria-label="Room name" value={room.label} maxLength={100} onChange={e => apply(replaceRoomLayout(floor.layout!, room.id, { type: "room", id: room.id, label: e.target.value }))} /></label>}
      <div className={s.addRow}><select aria-label="Room split direction" value={axis} onChange={e => setAxis(e.target.value as "x" | "z")}><option value="x">East / west</option><option value="z">North / south</option></select><button title="Split room" aria-label="Split room" disabled={rooms.length >= 32} onClick={split}><Columns2 size={17} /></button></div>
      {!!partitions.length && <>
        <label>Partition<select aria-label="Selected partition" value={wall?.node.id ?? ""} onChange={e => setWallId(e.target.value)}>{partitions.map((p, i) => <option key={p.node.id} value={p.node.id}>Partition {i + 1} / {p.node.axis === "x" ? "east-west rooms" : "north-south rooms"}</option>)}</select></label>
        {wall && <>
          <label>Position (m)<input aria-label="Partition position" type="number" step={0.1} value={wall.node.position} onChange={e => editWall({ position: Number(e.target.value) })} /></label>
          <div className={s.fields}>{(["offset", "width", "height"] as const).map(key => <label key={key}>Door {key} (m)<input aria-label={`Interior door ${key}`} type="number" step={0.1} value={wall.node.door[key]} onChange={e => editWall({ door: { ...wall.node.door, [key]: Number(e.target.value) } })} /></label>)}</div>
          {wall.node.a.type === "room" && wall.node.b.type === "room" && <button title="Merge rooms" aria-label="Merge rooms" onClick={() => apply(replaceRoomLayout(floor.layout!, wall.node.id, wall.node.a))}><Trash2 size={16} />Merge rooms</button>}
        </>}
      </>}
    </>}
  </section>;
}
