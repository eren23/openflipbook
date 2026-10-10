"use client";
import { useEffect, useRef, useState } from "react";
interface Choices { source_sha256: string; places: { id: string; label: string }[]; views: { id: string; label: string; place_ids: string[] }[];
  videos: { id: string; label: string }[]; publications: { id: string; title: string }[]; imported_snapshot?: boolean }
export default function WorldPublication({ sessionId }: { sessionId: string }) {
  const [choices, setChoices] = useState<Choices | null>(null), [places, setPlaces] = useState<string[]>([]), [views, setViews] = useState<string[]>([]), [videos, setVideos] = useState<string[]>([]);
  const [title, setTitle] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const frozen = useRef<string | null>(null), sequence = useRef(0);
  const url = `/api/world/${encodeURIComponent(sessionId)}/publications`;
  const reload = async () => {
    const ticket = ++sequence.current, res = await fetch(url, { cache: "no-store" }), data = await res.json();
    if (ticket !== sequence.current) return;
    if (!res.ok) throw new Error(data.error ?? "Publication library unavailable"); setChoices(data);
  };
  useEffect(() => { let alive = true; void reload().catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; sequence.current++; }; }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string, selected: string[], set: (v: string[]) => void) => { frozen.current = null; set(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]); };
  const publish = async () => {
    if (!choices) return; setBusy(true); setError("");
    frozen.current ??= JSON.stringify({ id: crypto.randomUUID(), title, place_ids: places, view_ids: views, path_ids: videos, source_sha256: choices.source_sha256, confirmed: true });
    try { const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: frozen.current }), data = await res.json();
      if (!res.ok) { if (res.status < 500) frozen.current = null; throw new Error(data.error ?? "Publication unavailable"); }
      frozen.current = null; await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Publication unavailable"); } finally { setBusy(false); }
  };
  const remove = async (id: string) => { setBusy(true); setError(""); try {
    const res = await fetch(`${url}?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" } });
    if (!res.ok) throw new Error((await res.json()).error ?? "Unpublish failed"); await reload();
  } catch (e) { setError(e instanceof Error ? e.message : "Unpublish failed"); } finally { setBusy(false); } };
  return <details><summary>Publish selected world content</summary>
    <p>Share an immutable snapshot of selected places, views and finished videos. Later edits stay in your workspace.</p>
    <label>Public title <input value={title} maxLength={120} disabled={busy} onChange={e => { frozen.current = null; setTitle(e.target.value); }} /></label>
    <fieldset disabled={busy}><legend>Places and their bound materials and meshes</legend>{choices?.places.map(x => <label key={x.id}><input type="checkbox" checked={places.includes(x.id)} onChange={() => toggle(x.id, places, setPlaces)} />{x.label}</label>)}</fieldset>
    <fieldset disabled={busy}><legend>Saved views</legend>{choices?.views.map(x => <label key={x.id}><input type="checkbox" checked={views.includes(x.id)} onChange={() => toggle(x.id, views, setViews)} />{x.label}</label>)}</fieldset>
    <fieldset disabled={busy}><legend>Finished videos</legend>{choices?.videos.map(x => <label key={x.id}><input type="checkbox" checked={videos.includes(x.id)} onChange={() => toggle(x.id, videos, setVideos)} />{x.label}</label>)}</fieldset>
    <button disabled={busy || !title.trim() || !places.length} onClick={() => void publish()}>Publish selected snapshot</button>
    <button disabled={busy} onClick={() => void reload().catch(e => setError(e.message))}>Refresh selection</button>
    {error && <p role="alert">{error}</p>}
    {choices?.imported_snapshot && <p><a href={`/sketch/snapshot/${sessionId}`}>Saved publication views and videos</a></p>}
    {choices?.publications.map(x => <p key={x.id}><a href={`/w/${x.id}`} target="_blank" rel="noreferrer">{x.title}</a> <button disabled={busy} onClick={() => void remove(x.id)}>Unpublish</button></p>)}
  </details>;
}
