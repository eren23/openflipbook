"use client";

import { useState } from "react";

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

  const fork = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: nodeId }),
        }
      );
      if (!res.ok) throw new Error(`fork ${res.status}`);
      const { session_id } = (await res.json()) as { session_id: string };
      window.location.href = `/play?continue=${encodeURIComponent(session_id)}`;
    } catch {
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
