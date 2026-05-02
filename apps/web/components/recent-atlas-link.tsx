"use client";

import { useEffect, useState } from "react";

/** Reads the last-known session id from localStorage and renders a link to
 *  its atlas. Renders nothing on first paint and when no session is known —
 *  keeps SSR markup stable and the landing tidy for first-time visitors. */
export default function RecentAtlasLink() {
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const id = window.localStorage.getItem("openflipbook.lastSession");
      if (id && id.trim()) setSessionId(id.trim());
    } catch {
      /* no-op */
    }
  }, []);

  if (!sessionId) return null;

  return (
    <a
      href={`/atlas/${encodeURIComponent(sessionId)}`}
      className="rounded-full border border-[var(--color-ink)]/30 px-3 py-1 text-xs hover:bg-[var(--color-ink)]/5"
    >
      Open your last atlas →
    </a>
  );
}
