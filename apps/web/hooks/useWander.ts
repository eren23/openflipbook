"use client";

import { useEffect, useRef } from "react";

interface WanderCandidate {
  x_pct: number;
  y_pct: number;
  salience?: number;
}

/** Why a wander run ended on its own (the caller surfaces it). */
export type WanderStopReason = "max-pages" | "no-candidates" | "resolver-error";

/** Auto-explore spends real money per page — cap a run so a forgotten ▶
 *  can't wander away with the wallet. One more ▶ starts a fresh run. */
export const WANDER_MAX_PAGES = 8;

interface Options {
  /** Whether wander is currently on. */
  active: boolean;
  /** The play page's generation phase; we only auto-tap while "ready". */
  phase: string;
  /** Current page identity + fields, passed as primitives so the effect only
   *  re-arms when the page actually changes (not on every parent re-render). */
  nodeId: string | null;
  imageDataUrl: string | null;
  title: string;
  query: string;
  /** Resolved output locale to pass through to the candidate resolver. */
  outputLocale: string | null;
  /** Fire the existing tap flow at a normalized point (reuses everything). */
  dispatchTapAt: (xPct: number, yPct: number) => void;
  /** Called when wander can't continue — max pages reached, a page with no
   *  candidates, or the resolver erroring — so the caller can toggle it off
   *  and say why. */
  onExhausted: (reason: WanderStopReason) => void;
  /** ms to linger on a freshly-arrived page before the next auto-tap. */
  lingerMs?: number;
  /** Auto-taps per activation before wander stops itself. */
  maxPages?: number;
}

/**
 * Auto-explore ("Wander"): while active and the page is idle, fetch the ranked
 * clickable regions for the current page, pick one of the most salient, and
 * fire a real tap at it after a short linger — so the world explores itself,
 * hands-free, deeper page by page. Reuses the precompute-candidates resolver
 * and the page's own tap flow; stops on toggle-off or when a page yields no
 * candidates. Picking randomly among the top few avoids ping-ponging between
 * two pages.
 */
export function useWander({
  active,
  phase,
  nodeId,
  imageDataUrl,
  title,
  query,
  outputLocale,
  dispatchTapAt,
  onExhausted,
  lingerMs = 2600,
  maxPages = WANDER_MAX_PAGES,
}: Options): void {
  // The last node we auto-tapped FROM, so a page is only wandered once even as
  // the effect re-runs.
  const tappedFrom = useRef<string | null>(null);
  // Auto-taps this activation — reset on toggle-off so one more ▶ starts a
  // fresh run.
  const tapCount = useRef(0);
  // The page's non-identity fields ride a ref, NOT the effect deps: the image
  // data-URL string is re-minted after a page settles (the change-stream
  // reconcile), and if the effect depended on it, that re-run would clear the
  // pending linger timer AND early-return on tappedFrom — so the auto-tap never
  // fired and Wander silently stalled. Arm on nodeId alone; read the rest here.
  const latest = useRef({ imageDataUrl, title, query, outputLocale });
  latest.current = { imageDataUrl, title, query, outputLocale };

  useEffect(() => {
    if (!active) {
      tappedFrom.current = null;
      tapCount.current = 0;
      return;
    }
    // Only auto-tap from a settled page whose pixels we can resolve, and only
    // once per node.
    if (
      phase !== "ready" ||
      !nodeId ||
      !latest.current.imageDataUrl?.startsWith("data:") ||
      tappedFrom.current === nodeId
    ) {
      return;
    }
    // The spend seatbelt: a forgotten ▶ stops itself after maxPages taps.
    if (tapCount.current >= maxPages) {
      onExhausted("max-pages");
      return;
    }
    tappedFrom.current = nodeId;

    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      try {
        const snap = latest.current;
        const res = await fetch("/api/precompute-candidates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_data_url: snap.imageDataUrl,
            parent_title: snap.title,
            parent_query: snap.query,
            output_locale: snap.outputLocale,
            max_candidates: 6,
          }),
          signal: ac.signal,
        });
        if (!res.ok) {
          onExhausted("resolver-error");
          return;
        }
        const data = (await res.json()) as { candidates?: WanderCandidate[] };
        const cands = (data.candidates ?? []).filter(
          (c) => typeof c?.x_pct === "number" && typeof c?.y_pct === "number"
        );
        if (cands.length === 0) {
          onExhausted("no-candidates");
          return;
        }
        cands.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
        // Wander with a little serendipity: a random pick among the top 3 keeps
        // the journey from looping between the two most-salient spots.
        const pool = cands.slice(0, Math.min(3, cands.length));
        const pick = pool[Math.floor(Math.random() * pool.length)]!;
        timer = setTimeout(() => {
          if (!ac.signal.aborted) {
            tapCount.current += 1;
            dispatchTapAt(pick.x_pct, pick.y_pct);
          }
        }, lingerMs);
      } catch {
        // Aborted (page changed / toggled off) or network error — the next
        // ready page re-arms; a hard failure surfaces as no next tap.
      }
    })();

    return () => {
      ac.abort();
      if (timer) clearTimeout(timer);
    };
    // Arm on identity only: active/phase/nodeId. The page's mutable fields
    // (image, title, query, locale) ride `latest` so a re-mint of the data URL
    // can't cancel the in-flight linger timer.
     
  }, [active, phase, nodeId, dispatchTapAt, onExhausted, lingerMs, maxPages]);
}
