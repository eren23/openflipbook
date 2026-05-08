"use client";

import type { FormEvent } from "react";

interface Props {
  instruction: string;
  setInstruction: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  placeholder: string;
  applyLabel: string;
}

/**
 * Bottom-of-figure inline form for "describe how to change this image"
 * edit-mode. Parent owns editMode visibility + busy gate; this is just
 * the visual form.
 */
export function EditForm({
  instruction,
  setInstruction,
  onSubmit,
  busy,
  placeholder,
  applyLabel,
}: Props) {
  return (
    <form
      onSubmit={onSubmit}
      className="absolute bottom-0 left-0 right-0 flex items-center gap-2 bg-black/65 px-3 py-2"
    >
      <input
        autoFocus
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={placeholder}
        className="flex-1 rounded-full bg-white/95 px-3 py-1 text-sm text-black outline-none placeholder:opacity-60"
      />
      <button
        type="submit"
        disabled={busy || instruction.trim().length === 0}
        className="rounded-full bg-amber-500 px-3 py-1 text-xs text-black disabled:opacity-50"
      >
        {applyLabel}
      </button>
    </form>
  );
}
