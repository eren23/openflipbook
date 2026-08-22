"use client";

import { useState } from "react";

import TourPlayer from "@/components/tour-player";
import type { TourNode } from "@/lib/tour";

// "▶ tour" — fetch the session graph once on demand and hand it to the
// player. Sits on the share surfaces (/n/, the embed); a world with a
// single page still plays (one hold + the end card).

interface TourButtonProps {
  sessionId: string;
  continueUrl: string;
  className?: string;
}

export default function TourButton({
  sessionId,
  continueUrl,
  className,
}: TourButtonProps) {
  const [nodes, setNodes] = useState<TourNode[] | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}?limit=200`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const json = (await res.json()) as { nodes: TourNode[] };
      if (json.nodes.length > 0) setNodes(json.nodes);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className={
          className ??
          "rounded-full border border-[var(--color-ink)]/40 px-3 py-1 text-xs hover:bg-[var(--color-ink)]/5 disabled:opacity-50"
        }
        title="Watch this world play itself — every page, diving into each tap"
      >
        {busy ? "loading…" : "▶ tour"}
      </button>
      {nodes && (
        <TourPlayer
          nodes={nodes}
          continueUrl={continueUrl}
          onClose={() => setNodes(null)}
        />
      )}
    </>
  );
}
