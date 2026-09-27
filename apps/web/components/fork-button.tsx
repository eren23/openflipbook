"use client";

import { useRef, useState } from "react";

// "Fork this world" on the share surfaces: copy the whole session (nodes +
// world model, images by reference, $0) into a fresh one the viewer OWNS,
// then open it live. The safer sibling of "Continue this session", which
// writes into the original.

interface ForkButtonProps {
  sessionId: string;
  nodeId: string;
}

export default function ForkButton({ sessionId, nodeId }: ForkButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<{ source: string; body: { node_id: string; request_id: string } } | null>(null);
  const inFlight = useRef(false);

  const fork = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const identity = await fetch("/api/creator/identity", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!identity.ok) throw new Error("Workspace identity unavailable");
      const source = `${sessionId}:${nodeId}`;
      if (pending.current?.source !== source) pending.current = { source, body: { node_id: nodeId, request_id: crypto.randomUUID() } };
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pending.current.body),
        }
      );
      if (!res.ok) throw new Error(`fork ${res.status}`);
      const { session_id } = (await res.json()) as { session_id: string };
      window.location.href = `/play?continue=${encodeURIComponent(session_id)}`;
    } catch {
      inFlight.current = false;
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={fork}
      disabled={busy}
      className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 text-xs hover:bg-[var(--color-ink)]/5 disabled:opacity-50"
      title="Copy this whole world into a fresh session of your own — the original stays untouched"
    >
      {busy ? "forking…" : failed ? "fork failed — retry" : "Fork this world"}
    </button>
  );
}
