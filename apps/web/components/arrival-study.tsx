"use client";
/* eslint-disable @next/next/no-img-element -- study page shows the exact fixture files */

import { useEffect, useState } from "react";
import { ArrowLeft, Download, ImageOff, RefreshCw } from "lucide-react";
import { ARRIVAL_POLICIES, arrivalStatus, type ArrivalReport } from "@/lib/arrival-study";
import s from "./arrival-study.module.css";

const asset = (file: string) => `/api/dev/arrival-assets/${encodeURIComponent(file)}`;
const dollars = (value: string) => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "Unknown";
export default function ArrivalStudy() {
  const [report, setReport] = useState<ArrivalReport | null>(null), [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null), [reload, setReload] = useState(0);
  useEffect(() => {
    const ac = new AbortController(); setError(null);
    void fetch(asset("manifest.json"), { cache: "no-store", signal: ac.signal }).then(async res => {
      if (!res.ok) throw new Error("Arrival audit unavailable");
      const data = await res.json();
      if (data.version !== 1 || !Array.isArray(data.cases) || !data.cases.length || !Array.isArray(data.cells)) throw new Error("Invalid arrival audit");
      if (!ac.signal.aborted) setReport(data);
    }).catch(e => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [reload]);
  const c = report?.cases[selected] ?? report?.cases[0];
  return <main className={s.study}>
    <header className={s.header}><a href="/" className={s.back}><ArrowLeft size={17} />My Worlds</a><h1>Exterior arrivals</h1><div className={s.tools}><button title="Reload audit" aria-label="Reload audit" onClick={() => setReload(v => v + 1)}><RefreshCw size={18} /></button><a title="Download manifest" aria-label="Download manifest" href={asset("manifest.json")} download><Download size={18} /></a></div></header>
    {error && <p role="alert" className={s.error}>{error}</p>}
    {!report && !error && <p role="status">Loading audit...</p>}
    {report && c && <>
      <div className={s.summary}><span>{report.cells.length} planned trials</span><span>Reserved ${dollars(report.reserved_usd)}</span><span>Approved ${dollars(report.approved_cap_usd)}</span><strong>Experimental</strong></div>
      <nav className={s.tabs} role="tablist" aria-label="Arrival cases">{report.cases.map((item, i) => <button role="tab" key={item.id} aria-selected={i === selected} onClick={() => setSelected(i)}>{item.title}</button>)}</nav>
      <div className={s.inputs}>
        <section><h2>Source map</h2><div className={s.source}><img src={asset(c.source)} alt={c.title} /><div data-testid="review-box" className={s.box} style={{ left: `${c.review.bbox[0]*100}%`, top: `${c.review.bbox[1]*100}%`, width: `${c.review.bbox[2]*100}%`, height: `${c.review.bbox[3]*100}%` }} /><div className={s.point} style={{ left: `${c.click.x_pct*100}%`, top: `${c.click.y_pct*100}%` }} /></div><p className={s.caption}>Click {c.click.x_pct.toFixed(3)}, {c.click.y_pct.toFixed(3)}</p></section>
        <section><h2>Human review reference</h2><div className={s.crop}><img src={asset(`${c.id}-review.png`)} alt={`${c.title} review crop`} /></div><ul className={s.features}>{c.review.features.map(feature => <li key={feature}>{feature}</li>)}</ul><p className={s.caption}>{c.review.entrance}</p></section>
      </div>
      <div className={s.reference}><h2>Runtime reference</h2>{c.runtime_reference?.asset && <img className={s.runtimeCrop} src={asset(c.runtime_reference.asset)} alt={`${c.title} automatic reference`} />}<p>{c.runtime_reference ? `${c.runtime_reference.provenance} / ${c.runtime_reference.source_sha256.slice(0, 12)}` : "Not captured"}</p><span>Human annotations: evaluation only</span></div>
      <div className={s.comparison}>{ARRIVAL_POLICIES.map(policy => <section key={policy}><h2>{policy === "context_first" ? "Context first" : "Target first"}</h2>{report.cells.filter(cell => cell.case_id === c.id && cell.policy === policy).map(cell => <article key={cell.id} aria-label={`${policy} run ${cell.run}`} className={s.trial}><div className={s.result}>{cell.state === "complete" && cell.output_sha256 ? <img src={asset(`${cell.id}-candidate.png`)} alt={`${policy} run ${cell.run} candidate`} /> : <div><ImageOff size={28} /><span>No candidate</span></div>}</div><div className={s.trialmeta}><strong>Run {cell.run}</strong><span>{arrivalStatus(cell)}</span></div>{cell.arrival && <ul className={s.checks}>{Object.entries(cell.arrival.checks).map(([key, state]) => <li key={key}><span>{key.replaceAll("_", " ")}</span><strong>{state}</strong></li>)}</ul>}{cell.error && <p className={s.error}>{cell.error}</p>}{cell.human_review && <p>{cell.human_review.rationale}</p>}</article>)}</section>)}</div>
      {report.cells.filter(cell => cell.case_id === c.id && cell.visual_review).map(cell => <p className={s.caption} key={cell.id}><strong>{cell.policy.replaceAll("_", " ")} / run {cell.run}, assistant review:</strong> {cell.visual_review!.rationale}</p>)}
      <footer className={s.footer}><span>{report.model}</span><span>Manifest {report.fingerprint.slice(0, 12)}</span></footer>
    </>}
  </main>;
}
