"use client";

import { useEffect, useState } from "react";
import { Lock, Save } from "lucide-react";
import { NOTE_LIMIT, type AuthorNote } from "@/lib/creator-types";

export default function PrivateNoteEditor({ sessionId, placeId = null, onDirtyChange, onSaved }: {
  sessionId: string; placeId?: string | null; onDirtyChange?: (dirty: boolean) => void; onSaved?: () => void;
}) {
  const [note, setNote] = useState<AuthorNote | null>(null), [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [remote, setRemote] = useState<AuthorNote | null>(null), [refresh, setRefresh] = useState(0);
  const endpoint = `/api/creator/worlds/${encodeURIComponent(sessionId)}/notes`;
  const dirty = note !== null && text !== note.text;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const ac = new AbortController(); setLoading(true); setError(null); setNote(null); setText("");
    void fetch(endpoint, { signal: ac.signal, cache: "no-store" }).then(async res => {
      const data = await res.json(); if (!res.ok) throw new Error(data.error || "Could not load notes");
      const found = (data.notes as AuthorNote[]).find(n => n.place_id === placeId) ?? { place_id: placeId, label: "", text: "", revision: 0, updated_at: null };
      if (!ac.signal.aborted) { setNote(found); setText(found.text); setRemote(null); }
    }).catch(e => { if (!ac.signal.aborted) setError(e.message); }).finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [endpoint, placeId, refresh]);
  const save = async () => {
    if (!note || saving) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ place_id: placeId, text, revision: note.revision }) });
      const data = await res.json();
      if (res.status === 409) {
        const latest = await fetch(endpoint, { cache: "no-store" });
        if (!latest.ok) throw new Error("Conflict detected; saved version could not be loaded. Your draft is unchanged.");
        const found = ((await latest.json()).notes as AuthorNote[]).find(n => n.place_id === placeId);
        if (found) setRemote(found);
        throw new Error(data.error);
      }
      if (!res.ok) throw new Error(data.error || "Could not save note");
      setNote(data.note); setRemote(null); onSaved?.();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  return <section aria-label="Private note" className="space-y-3">
    <div className="flex items-center gap-2 text-xs opacity-70"><Lock size={14} />Private</div>
    {loading ? <p role="status" className="text-sm">Loading note...</p> : note && <>
      <textarea aria-label="Private notes" maxLength={NOTE_LIMIT} value={text} disabled={saving} onChange={e => setText(e.target.value)} className="block min-h-60 w-full resize-y rounded border border-[var(--color-edge)] bg-transparent p-3 text-sm leading-relaxed" />
      <div className="flex items-center justify-between gap-3 text-xs"><span role="status">{saving ? "Saving..." : dirty ? "Unsaved changes" : note.updated_at ? "Saved" : "No saved note"}</span><span>{text.length.toLocaleString()} / 20,000</span></div>
      <button type="button" disabled={saving || !dirty || remote !== null} onClick={() => void save()} className="flex min-h-9 items-center gap-2 rounded bg-emerald-700 px-3 py-2 text-sm text-white disabled:opacity-40"><Save size={16} />Save note</button>
    </>}
    {error && <div role="alert" className="text-sm text-red-700">{error}{!note && <button className="ml-2 underline" onClick={() => setRefresh(v => v + 1)}>Retry</button>}</div>}
    {remote && <div className="space-y-3 border-t border-[var(--color-edge)] pt-4"><h3 className="text-sm font-semibold">Saved version</h3><pre className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words text-sm">{remote.text}</pre><div className="flex flex-wrap gap-3 text-sm"><button className="rounded border px-3 py-2" onClick={() => { setNote(remote); setRemote(null); setError(null); }}>Keep my draft</button><button className="rounded border px-3 py-2" onClick={() => { if (window.confirm("Discard your draft and use the saved version?")) { setNote(remote); setText(remote.text); setRemote(null); setError(null); } }}>Use saved version</button></div></div>}
  </section>;
}
