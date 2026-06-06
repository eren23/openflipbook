"use client";

import { useState } from "react";

import type { EntityEditPlan, WorldEntityGeo } from "@openflipbook/config";

interface Props {
  entities: WorldEntityGeo[];
  // Resolve an instruction to a plan. dryRun=true previews (no write); dryRun=false
  // applies. Wired to POST /api/world/:id/edit-entities by the container.
  onSubmit: (instruction: string, dryRun: boolean) => Promise<EntityEditPlan>;
}

type Phase = "idle" | "busy" | "confirm";

// The living, NL-editable entity list (Phase 5). Shows each map entity's geometry
// as a chip, takes a natural-language edit, previews the structured plan + its
// blast-radius ("restages N scenes"), then applies on confirm. Presentational —
// the network lives in onSubmit. Rendered only behind the world-override flag.
export default function GeoEditPanel({ entities, onSubmit }: Props) {
  const [instruction, setInstruction] = useState("");
  const [plan, setPlan] = useState<EntityEditPlan | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const preview = async () => {
    const instr = instruction.trim();
    if (!instr) return;
    setPhase("busy");
    setError(null);
    try {
      const p = await onSubmit(instr, true);
      setPlan(p);
      if (p.edits.length === 0) {
        setError("No change understood from that instruction.");
        setPhase("idle");
      } else {
        setPhase("confirm");
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  };

  const apply = async () => {
    setPhase("busy");
    setError(null);
    try {
      await onSubmit(instruction.trim(), false);
      setPlan(null);
      setInstruction("");
      setPhase("idle");
    } catch (e) {
      setError((e as Error).message);
      setPhase("confirm");
    }
  };

  const cancel = () => {
    setPlan(null);
    setPhase("idle");
  };

  return (
    <div className="flex flex-col gap-2" data-testid="geo-edit">
      <ul className="space-y-0.5 text-xs text-stone-600" data-testid="geo-chips">
        {entities.length === 0 ? (
          <li className="italic text-stone-400">no map entities yet</li>
        ) : (
          entities.map((e) => (
            <li key={e.id} className="flex items-center gap-1.5">
              <span className="font-medium">{e.label || e.id}</span>
              <span className="text-stone-400">
                ({Math.round(e.pos.x)},{Math.round(e.pos.y)}) · h{Math.round(e.height)}
                {e.elevation ? ` ↑${Math.round(e.elevation)}` : ""}
              </span>
              <span className="rounded bg-stone-200 px-1 text-[10px] text-stone-500">
                {e.source}
              </span>
            </li>
          ))
        )}
      </ul>

      <textarea
        value={instruction}
        onChange={(ev) => setInstruction(ev.target.value)}
        placeholder="e.g. move the lighthouse north a bit, make the clock tower taller"
        rows={2}
        className="rounded border border-stone-300 p-1.5 text-xs"
        disabled={phase === "busy"}
        aria-label="natural-language map edit"
      />

      {phase !== "confirm" ? (
        <button
          type="button"
          onClick={preview}
          disabled={phase === "busy" || instruction.trim().length === 0}
          className="self-start rounded bg-blue-600 px-2 py-1 text-xs text-white disabled:opacity-40"
        >
          {phase === "busy" ? "Thinking…" : "Preview edit"}
        </button>
      ) : (
        plan && (
          <div className="flex flex-col gap-1 rounded border border-blue-200 bg-blue-50 p-2" data-testid="confirm">
            <p className="text-xs text-stone-700">
              {plan.edits.length} edit{plan.edits.length === 1 ? "" : "s"}.{" "}
              {plan.blast_radius.length > 0
                ? `Restages ${plan.blast_radius.length} saved scene${
                    plan.blast_radius.length === 1 ? "" : "s"
                  }.`
                : "No saved scenes affected."}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={apply}
                className="rounded bg-blue-600 px-2 py-1 text-xs text-white"
              >
                Apply{plan.blast_radius.length > 0 ? " & flag for restage" : ""}
              </button>
              <button
                type="button"
                onClick={cancel}
                className="rounded px-2 py-1 text-xs text-stone-500"
              >
                Cancel
              </button>
            </div>
          </div>
        )
      )}

      {error && (
        <p className="text-xs text-red-600" data-testid="geo-error">
          {error}
        </p>
      )}
    </div>
  );
}
