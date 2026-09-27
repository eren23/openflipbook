"use client";
import { RotateCcw } from "lucide-react";
import { DEFAULT_MESH_ORIENTATION, SOURCE_AXES, type MeshOrientation } from "@/lib/mesh-orientation";
import s from "./world-editor.module.css";

export default function MeshOrientationEditor({ value = DEFAULT_MESH_ORIENTATION, disabled, onChange }: {
  value?: MeshOrientation | undefined; disabled: boolean; onChange: (value: MeshOrientation) => void;
}) {
  const names = { x: "Source pitch", y: "Source yaw", z: "Source roll" };
  return <div role="group" aria-label="Mesh source orientation">
    <div className={s.fields}>{SOURCE_AXES.map(axis => <label key={axis}>{names[axis]}
      <select aria-label={names[axis]} disabled={disabled} value={value[axis]} onChange={e => onChange({ ...value, [axis]: Number(e.target.value) })}>
        {[0, 1, 2, 3].map(turn => <option key={turn} value={turn}>{turn * 90} degrees</option>)}
      </select>
    </label>)}</div>
    <button aria-label="Reset mesh source orientation" title="Reset mesh source orientation" disabled={disabled || SOURCE_AXES.every(axis => value[axis] === 0)} onClick={() => onChange({ ...DEFAULT_MESH_ORIENTATION })}><RotateCcw size={16}/></button>
  </div>;
}
