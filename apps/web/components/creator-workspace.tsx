"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowRight, BookOpen, Box, Check, Compass, ImageOff, Map, Pencil, Pin, Plus, Search, Upload, X } from "lucide-react";
import { creatorWorldUrl, type WorldSummary } from "@/lib/creator-types";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";
import CreatorNotebook from "./creator-notebook";
import WorldImporter from "./world-importer";
import WorldRecovery from "./world-recovery";
import s from "./creator-workspace.module.css";

export default function CreatorWorkspace() {
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [notebook, setNotebook] = useState<WorldSummary | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = async (next: string | null, signal: AbortSignal) => {
    setLoading(true); setError(null); setUnconfigured(false);
    try {
      const params = new URLSearchParams({ q: query, archived: String(archived), ...(next ? { cursor: next } : {}) });
      const res = await fetch(`/api/creator/worlds?${params}`, { signal, cache: "no-store" });
      const data = await res.json();
      if (!res.ok) { if (data.error === "Persistence is not configured") setUnconfigured(true); throw new Error(data.error || "Could not load worlds"); }
      if (signal.aborted) return;
      setWorlds(old => next ? [...old, ...data.worlds] : data.worlds); setCursor(data.next_cursor);
    } catch (e) { if (!signal.aborted) setError((e as Error).message); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    request.current?.abort();
    const ac = new AbortController(); request.current = ac;
    setWorlds([]); setCursor(null); setLoading(true);
    const timer = setTimeout(() => void load(null, ac.signal), 180);
    return () => { clearTimeout(timer); ac.abort(); request.current?.abort(); };
    // Each filter change starts a new cancellable result set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, archived, refresh]);

  return <main className={s.workspace}>
    <header className={s.header}><a href="/" className={s.brand}>openflipbook</a><nav className={s.actions} aria-label="Workspace"><WorldRecovery onRecovered={() => { setQuery(""); setArchived(false); setRefresh(v => v + 1); }} /><a href="/gallery" className={s.button}><Compass size={16} />Explore</a><a href="/status" className={s.button}>Status</a></nav></header>
    <section className={s.content} aria-labelledby="worlds-title">
      <div className={s.title}><h1 id="worlds-title">My Worlds</h1><div className={s.actions}>
        <WorldImporter onImported={() => setRefresh(v => v + 1)} />
        {(process.env.NEXT_PUBLIC_SKETCH_ENABLED === "1" || (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_SKETCH_ENABLED !== "0")) && <a className={s.button} href="/sketch"><Pencil size={16} />New Sketch</a>}
        <a className={s.button} href="/play?upload=1"><Upload size={16} />Upload Map</a>
        {placeScenesEnabled() && <a className={s.button} href="/sketch/world"><Box size={16} />New 3D World</a>}
        <a className={`${s.button} ${s.primary}`} href="/play"><Plus size={16} />New World</a>
      </div></div>
      <div className={s.filters}><div className={s.tabs} role="tablist" aria-label="World collection">{[false, true].map(value => <button key={String(value)} role="tab" aria-selected={archived === value} onClick={() => setArchived(value)}>{value ? "Archived" : "Active"}</button>)}</div><label className={s.search}><Search size={17} /><input aria-label="Search worlds" placeholder="Search worlds" value={query} onChange={e => setQuery(e.target.value)} maxLength={160} /></label></div>
      {error && <div role="alert" className={s.error}>{error} {unconfigured ? <a href="/status" className={s.button}>Open status</a> : <button className={s.button} onClick={() => setRefresh(v => v + 1)}>Retry</button>}</div>}
      {loading && !worlds.length && <p role="status" className={s.empty}>Loading worlds...</p>}
      {!loading && !error && !worlds.length && <div className={s.empty}><Map size={40} /><h2>{query ? "No matching worlds" : archived ? "No archived worlds" : "No saved worlds in this browser"}</h2>{!query && !archived && <a className={`${s.button} ${s.primary}`} href="/play"><Plus size={16} />New World</a>}</div>}
      <div className={s.grid}>{worlds.map(world => <WorldCard key={world.id} world={world} onChanged={() => setRefresh(v => v + 1)} onNotebook={() => setNotebook(world)} />)}</div>
      {cursor && <div className={s.footer}><button className={s.button} disabled={loading} onClick={() => { const ac = new AbortController(); request.current?.abort(); request.current = ac; void load(cursor, ac.signal); }}>{loading ? "Loading..." : "Load more"}</button></div>}
    </section>
    {notebook && <CreatorNotebook sessionId={notebook.id} title={notebook.title} onClose={() => setNotebook(null)} />}
  </main>;
}

function WorldCard({ world, onChanged, onNotebook }: { world: WorldSummary; onChanged: () => void; onNotebook: () => void }) {
  const [renaming, setRenaming] = useState(false), [title, setTitle] = useState(world.title);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [imageFailed, setImageFailed] = useState(false);
  const patch = async (body: object) => {
    setBusy(true); setError(null);
    try { const res = await fetch(`/api/creator/worlds/${encodeURIComponent(world.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!res.ok) throw new Error((await res.json()).error || "Could not save world"); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const resume = creatorWorldUrl(world);
  return <article className={s.card} aria-label={world.title}>
    {/* eslint-disable-next-line @next/next/no-img-element -- R2 cover; next/image adds a loader hop */}
    <a href={resume} className={s.cover} aria-label={`Open ${world.title}`}>{world.image_url && !imageFailed ? <img src={world.image_url} alt={world.title} loading="lazy" onError={() => setImageFailed(true)} /> : world.place_count && !world.node_count ? <Box size={40} aria-label="3D world" /> : <ImageOff size={32} aria-label="Preview unavailable" />}</a>
    <div className={s.details}>{renaming ? <form className={s.rename} onSubmit={e => { e.preventDefault(); void patch({ title }); }}><input aria-label="World title" value={title} maxLength={160} autoFocus onChange={e => setTitle(e.target.value)} /><button className={s.icon} disabled={busy || !title.trim()} title="Save title" aria-label="Save title"><Check size={17} /></button><button type="button" className={s.icon} title="Cancel rename" aria-label="Cancel rename" onClick={() => { setTitle(world.title); setRenaming(false); }}><X size={17} /></button></form> : <h2>{world.title}</h2>}
      <p className={s.meta}>{world.node_count} saved {world.node_count === 1 ? "view" : "views"}{!!world.place_count && ` / ${world.place_count} ${world.place_count === 1 ? "place" : "places"}`} &middot; {new Date(world.last_opened_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
      <div className={s.cardfooter}><a className={s.button} href={resume}>Continue<ArrowRight size={15} /></a><button className={s.icon} aria-label="Open notebook" title="Notebook" onClick={onNotebook}><BookOpen size={17} /></button><button className={s.icon} disabled={busy} aria-label={world.pinned ? "Unpin world" : "Pin world"} title={world.pinned ? "Unpin" : "Pin"} aria-pressed={world.pinned} onClick={() => void patch({ pinned: !world.pinned })}><Pin size={16} /></button><button className={s.icon} disabled={busy} aria-label="Rename world" title="Rename" onClick={() => setRenaming(true)}><Pencil size={16} /></button><button className={s.icon} disabled={busy} aria-label={world.archived ? "Restore world" : "Archive world"} title={world.archived ? "Restore" : "Archive"} onClick={() => void patch({ archived: !world.archived })}>{world.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}</button></div>
      {error && <p role="alert" className={s.error}>{error}</p>}
    </div>
  </article>;
}
