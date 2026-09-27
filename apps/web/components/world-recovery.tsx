"use client";
import { useRef, useState } from "react";
import { Check, KeyRound, X } from "lucide-react";
import s from "./creator-workspace.module.css";

export default function WorldRecovery({ onRecovered }: { onRecovered: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(false);
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState("");
  const close = () => { if (!active.current) { dialog.current?.close(); setCode(""); setError(""); setDone(false); } };
  async function restore() {
    if (active.current || !code.trim()) return;
    active.current = true; setBusy(true); setError("");
    const value = code.trim();
    try {
      for (const [url, body] of [["/api/creator/identity", {}], ["/api/creator/recovery", { code: value }]] as const) {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
        const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Access recovery failed");
      }
      setDone(true); setCode(""); onRecovered();
    } catch (e) { setError((e as Error).message); } finally { active.current = false; setBusy(false); }
  }
  return <>
    <button className={s.button} onClick={() => dialog.current?.showModal()}><KeyRound size={16} />Recover World</button>
    <dialog ref={dialog} className={s.importDialog} aria-labelledby="world-recovery-title" onCancel={e => { e.preventDefault(); close(); }}>
      <header className={s.importHeader}><h2 id="world-recovery-title">Recover World</h2><button className={s.icon} aria-label="Close recovery" title="Close recovery" disabled={busy} onClick={close}><X size={18} /></button></header>
      {done ? <div className={s.importFooter}><p role="status"><Check size={16} />Access restored</p><button className={s.button} onClick={close}>Done</button></div> : <form onSubmit={e => { e.preventDefault(); void restore(); }}>
        <label className={s.importFile}>Operator recovery code<input aria-label="Operator recovery code" type="password" autoComplete="off" maxLength={128} value={code} disabled={busy} onChange={e => setCode(e.target.value)} /></label>
        {error && <p role="alert" className={s.error}>{error}</p>}
        {busy && <p role="status">Restoring access...</p>}
        <div className={s.importFooter}><button className={`${s.button} ${s.primary}`} disabled={busy || !code.trim()}><KeyRound size={16} />Restore access</button><button type="button" className={s.button} disabled={busy} onClick={close}>Cancel</button></div>
      </form>}
    </dialog>
  </>;
}
