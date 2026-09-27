"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, X } from "lucide-react";
import type { AuthorNote } from "@/lib/creator-types";
import PrivateNoteEditor from "./private-note-editor";

export default function CreatorNotebook({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [notes, setNotes] = useState<AuthorNote[]>([]), [selected, setSelected] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const dirty = useRef(false), closeButton = useRef<HTMLButtonElement>(null);
  const setDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  const allow = () => !dirty.current || window.confirm("Discard unsaved note changes?");
  useEffect(() => {
    const ac = new AbortController();
    void fetch(`/api/creator/worlds/${encodeURIComponent(sessionId)}/notes`, { signal: ac.signal, cache: "no-store" }).then(async res => { if (res.ok) { const data = await res.json(); if (!ac.signal.aborted) setNotes(data.notes); } }).catch(() => {});
    return () => ac.abort();
  }, [sessionId, refresh]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null; closeButton.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!dirty.current || window.confirm("Discard unsaved note changes?")) onClose(); }
      if (e.key === "Tab") {
        const elements = [...(closeButton.current?.closest('[role="dialog"]')?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), a[href]') ?? [])];
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); opener?.focus(); };
  }, [onClose]);
  return <div className="fixed inset-0 z-[90] flex justify-end bg-black/25" onClick={e => { if (e.target === e.currentTarget && allow()) onClose(); }}>
    <aside role="dialog" aria-modal="true" aria-label="World notebook" className="flex h-dvh w-full max-w-xl flex-col bg-[var(--color-canvas)] text-[var(--color-ink)] shadow-xl">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-edge)] p-5"><div className="min-w-0"><h2 className="break-words text-lg font-semibold">{title}</h2><p className="mt-1 flex items-center gap-1 text-xs opacity-65"><Lock size={12} />Notebook</p></div><button ref={closeButton} className="grid h-9 w-9 shrink-0 place-items-center" title="Close notebook" aria-label="Close notebook" onClick={() => { if (allow()) onClose(); }}><X size={20} /></button></header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5"><nav aria-label="Notebook entries" className="mb-5 flex flex-wrap gap-2">{[{ place_id: null, label: "World notes", missing_place: false }, ...notes.filter(n => n.place_id !== null)].map(n => <button key={n.place_id ?? "world"} aria-pressed={selected === n.place_id} className={`max-w-full break-words rounded border px-3 py-2 text-left text-sm ${selected === n.place_id ? "border-emerald-600 bg-emerald-600/10" : "border-[var(--color-edge)]"}`} onClick={() => { if (n.place_id !== selected && allow()) setSelected(n.place_id); }}>{n.label}{n.missing_place ? " (place unavailable)" : ""}</button>)}</nav><PrivateNoteEditor key={selected ?? "world"} sessionId={sessionId} placeId={selected} onDirtyChange={setDirty} onSaved={() => setRefresh(v => v + 1)} /></div>
    </aside>
  </div>;
}
