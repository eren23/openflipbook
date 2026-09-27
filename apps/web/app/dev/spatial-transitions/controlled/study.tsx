"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import { canvasBox, CONTROLLED_IDS, expectedLandmark, sampleTime, type Box, type ControlledReport } from "@/lib/controlled-study";

const asset = (name: string) => `/api/dev/spatial-assets/controlled-${name}${name.endsWith(".mp4") ? "?v=seekable-1" : ""}`;
const tool = "inline-flex h-9 w-9 shrink-0 items-center justify-center border border-zinc-400 hover:bg-zinc-100 disabled:opacity-40";

export default function ControlledStudy() {
  const [report, setReport] = useState<ControlledReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string>(CONTROLLED_IDS[0]);
  const [progress, setProgress] = useState(0);
  const [nativeProgress, setNativeProgress] = useState<Record<string, number>>({});
  const [seeking, setSeeking] = useState<Record<string, boolean>>({});
  const [playing, setPlaying] = useState(false);
  const [overlay, setOverlay] = useState(true);
  const [missing, setMissing] = useState<string[]>([]);
  const videos = useRef<Record<string, HTMLVideoElement | null>>({});
  const load = useCallback(async () => {
    try {
      const response = await fetch(asset("summary.json"), { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "No pilot results yet." : "Results unavailable.");
      const data = await response.json() as ControlledReport;
      if (data.version !== 1 || !Array.isArray(data.results) || !data.fixture?.signature) throw new Error("Unsupported pilot report.");
      setReport(data); setError(null); setMissing([]);
    } catch (e) { setError(e instanceof Error ? e.message : "Results unavailable."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const pause = () => { for (const video of Object.values(videos.current)) video?.pause(); setPlaying(false); };
  const reset = () => { pause(); setProgress(0); setNativeProgress({}); for (const video of Object.values(videos.current)) if (video) video.currentTime = 0; };
  const seek = (value: number) => {
    pause(); setProgress(value); setNativeProgress({});
    for (const [id, video] of Object.entries(videos.current)) if (video && Number.isFinite(video.duration)) {
      const count = id === "reference" ? 121 : report?.results.find(r => r.id === id)?.metadata?.frame_count ?? 121;
      video.currentTime = sampleTime(value, video.duration, count);
    }
  };
  const play = async () => {
    setPlaying(true);
    try { for (const video of Object.values(videos.current)) if (video) await video.play(); }
    catch { pause(); setError("Playback unavailable. Reload the results or use the clip download."); }
  };
  const result = report?.results.find(r => r.id === selection);
  const signature = report?.fixture.signature;
  const panels = [
    { id: "reference", title: "Source pixels", file: "reference.mp4", width: 1280, height: 704, ready: !!report, frames: 121 },
    { id: selection, title: result?.label ?? "Generated clip", file: `${selection}.mp4`, width: result?.metadata?.width ?? 1280,
      height: result?.metadata?.height ?? 704, ready: result?.state === "complete", frames: result?.metadata?.frame_count ?? 121 },
  ];
  return <main className="mx-auto min-h-screen max-w-7xl bg-white p-4 text-zinc-900 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-300 pb-4">
      <div><Link className="inline-flex items-center gap-1 text-sm underline" href="/dev/spatial-transitions"><ArrowLeft size={14} /> Earlier study</Link>
        <h1 className="mt-2 text-2xl font-semibold">Crystal Lighthouse</h1></div>
      <div className="text-sm">Reserved: ${report?.reserved_usd ?? "0"} / ${report?.cap_usd ?? "3.00"}</div>
    </header>
    <div className="my-4 flex flex-wrap items-center gap-3">
      <select aria-label="Configuration" className="h-9 max-w-full border border-zinc-400 bg-white px-2 text-sm" value={selection} onChange={e => { reset(); setSelection(e.target.value); }}>
        {CONTROLLED_IDS.map(id => <option key={id} value={id}>{report?.results.find(r => r.id === id)?.label ?? id}</option>)}
      </select>
      <button className={tool} title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"} disabled={!report} onClick={() => playing ? pause() : void play()}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
      <button className={tool} title="Reset" aria-label="Reset" onClick={reset}><RotateCcw size={18} /></button>
      <button className={tool} title="Refresh results" aria-label="Refresh results" onClick={() => { reset(); void load(); }}><RefreshCw size={18} /></button>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overlay} onChange={e => setOverlay(e.target.checked)} /> Expected landmark</label>
    </div>
    {error && <p role="status" className="mb-4 border-l-4 border-amber-500 pl-3 text-sm">{error}</p>}
    <div className="grid gap-5 lg:grid-cols-2">
      {panels.map(panel => {
        const isFast = panel.id === "fast-101";
        const inputSize: [number, number] = isFast ? [1920, 1080] : [1280, 704];
        const rect = isFast ? report?.fixture.fast_content_rect : report?.fixture.content_rect;
        // Do not claim an overlay mapping when the provider changed the requested aspect.
        const aspectMatches = Math.abs(panel.width / panel.height - inputSize[0] / inputSize[1]) < 0.002;
        const expected: Box = signature ? expectedLandmark(signature.crop, signature.landmark, nativeProgress[panel.id] ?? progress) : [0, 0, 0, 0];
        const box = rect ? canvasBox(expected, rect, inputSize) : [0, 0, 0, 0];
        return <section key={panel.id} className="min-w-0">
          <h2 className="mb-2 text-base font-medium">{panel.title}</h2>
          <div data-testid={`pilot-${panel.id}`} className="flex min-w-0 items-center justify-center bg-zinc-950" style={{ aspectRatio: "16 / 9" }}>
            {panel.ready && !missing.includes(panel.id) ? <div className="relative max-h-full max-w-full" style={{ aspectRatio: `${panel.width} / ${panel.height}`, width: panel.width / panel.height >= 16 / 9 ? "100%" : undefined, height: panel.width / panel.height < 16 / 9 ? "100%" : undefined }}>
              <video ref={el => { videos.current[panel.id] = el; }} src={asset(panel.file)} controls muted playsInline preload="metadata" className="block h-full w-full" onError={() => setMissing(prev => [...prev, panel.id])}
                onSeeking={() => setSeeking(prev => ({ ...prev, [panel.id]: true }))}
                onSeeked={() => setSeeking(prev => ({ ...prev, [panel.id]: false }))}
                onTimeUpdate={e => { const video = e.currentTarget; if (Number.isFinite(video.duration) && video.duration > 0) {
                  const value = Math.min(1, video.currentTime / sampleTime(1, video.duration, panel.frames));
                  setNativeProgress(prev => ({ ...prev, [panel.id]: value }));
                  if (panel.id === "reference" && !video.paused) setProgress(value);
                } }}
                onEnded={() => { if (panel.id === selection) setPlaying(false); }} />
              {overlay && !seeking[panel.id] && aspectMatches && rect && <div data-testid={`overlay-${panel.id}`} className="pointer-events-none absolute border-2 border-emerald-400" style={{ left: `${box[0]! * 100}%`, top: `${box[1]! * 100}%`, width: `${box[2]! * 100}%`, height: `${box[3]! * 100}%` }} />}
            </div> : <p className="p-4 text-center text-sm text-zinc-300">{missing.includes(panel.id) ? "Clip unavailable" : panel.id !== "reference" && result?.state === "stopped" ? "Generation stopped" : panel.id !== "reference" && result?.state === "submitted" ? "Generating" : panel.id !== "reference" && result?.state === "reserved" ? "Submission pending" : "Not generated"}</p>}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-zinc-600">
            <span>{panel.ready ? `${panel.width} x ${panel.height}${panel.id === "reference" ? " / 5.042s" : ` / ${result?.metadata?.duration_seconds.toFixed(3)}s`}` : "Pending"}</span>
            {panel.ready && <a href={asset(panel.file)} download title="Download clip" aria-label={`Download ${panel.title}`} className="inline-flex h-8 items-center gap-1"><Download size={15} /> MP4</a>}
          </div>
          {!aspectMatches && <p className="text-sm text-amber-700">Output aspect changed; landmark overlay unavailable.</p>}
        </section>;
      })}
    </div>
    <label className="mt-5 flex items-center gap-3 text-sm">Progress
      <input className="min-w-0 flex-1" aria-label="Normalized progress" type="range" min={0} max={1} step={0.01} value={progress} onChange={e => seek(Number(e.target.value))} />
      <output className="w-12 text-right tabular-nums">{Math.round(progress * 100)}%</output>
    </label>
    <section className="mt-5 border-t border-zinc-300 pt-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt>Visual verdict</dt><dd>{result?.visual_verdict ?? "unreviewed"}</dd>
        <dt>Geometry audit</dt><dd>{result?.geometry?.sampled_geometry ?? "unverified"}</dd>
        <dt>Provider billing</dt><dd>{result?.reported_cost_usd != null ? `$${result.reported_cost_usd}` : "Unavailable"}</dd>
        <dt>State</dt><dd>{result?.state ?? "not_submitted"}</dd>
      </dl>
      {result?.error && <p className="mt-3 break-words text-red-700">{result.error}</p>}
      <div className="mt-3 flex flex-wrap gap-4 underline"><a href={asset("summary.json")} download>Study receipt</a>
        {result?.state !== "not_submitted" && result && <a href={asset(`${selection}-receipt.json`)} download>Configuration receipt</a>}
        {result?.state === "complete" && <a href={asset(`${selection}-contact.jpg`)} target="_blank" rel="noreferrer">Frame audit</a>}</div>
    </section>
  </main>;
}
