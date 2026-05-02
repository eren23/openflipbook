"use client";

import { useEffect, useState } from "react";

export interface HeatmapChild {
  id: string;
  page_title: string;
  image_url: string | null;
  click_in_parent: { x_pct: number; y_pct: number } | null;
  created_at: string;
}

interface HeatmapOverlayProps {
  parentId: string;
  /** Optional injection (e.g. from /atlas where children are already loaded). */
  children?: HeatmapChild[];
  className?: string;
}

interface FetchState {
  status: "idle" | "loading" | "ready" | "error";
  children: HeatmapChild[];
}

export default function HeatmapOverlay({
  parentId,
  children,
  className,
}: HeatmapOverlayProps) {
  const [state, setState] = useState<FetchState>(() =>
    children
      ? { status: "ready", children }
      : { status: "idle", children: [] }
  );
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (children) {
      setState({ status: "ready", children });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", children: [] });
    (async () => {
      try {
        const res = await fetch(
          `/api/nodes/${encodeURIComponent(parentId)}/children`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { children: HeatmapChild[] };
        if (cancelled) return;
        setState({ status: "ready", children: json.children ?? [] });
      } catch {
        if (cancelled) return;
        setState({ status: "error", children: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parentId, children]);

  const points = state.children.filter(
    (c): c is HeatmapChild & {
      click_in_parent: { x_pct: number; y_pct: number };
    } => c.click_in_parent != null
  );

  // SVG `id` is document-scoped. Two HeatmapOverlay instances with the same
  // gradient id would clobber each other in the DOM — later <defs> wins,
  // earlier blobs render against it. Scope by parentId.
  const gradId = `ofb-heat-blob-${parentId}`;

  return (
    <div
      className={
        "pointer-events-none absolute inset-0 " + (className ?? "")
      }
      aria-hidden="true"
    >
      {/* Soft heatmap blob layer — non-interactive. */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <defs>
          <radialGradient id={gradId}>
            <stop offset="0%" stopColor="rgba(239,68,68,0.55)" />
            <stop offset="60%" stopColor="rgba(239,68,68,0.18)" />
            <stop offset="100%" stopColor="rgba(239,68,68,0)" />
          </radialGradient>
        </defs>
        {points.map((p) => (
          <ellipse
            key={`b-${p.id}`}
            cx={p.click_in_parent.x_pct * 100}
            cy={p.click_in_parent.y_pct * 100}
            rx={6}
            ry={9}
            fill={`url(#${gradId})`}
            style={{ mixBlendMode: "multiply" }}
          />
        ))}
      </svg>

      {/* Interactive pin layer. */}
      <div className="absolute inset-0">
        {points.map((p) => (
          <a
            key={p.id}
            href={`/n/${encodeURIComponent(p.id)}`}
            className="ofb-heat-pin pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
            style={{
              left: `${p.click_in_parent.x_pct * 100}%`,
              top: `${p.click_in_parent.y_pct * 100}%`,
            }}
            onMouseEnter={() => setHovered(p.id)}
            onMouseLeave={() =>
              setHovered((cur) => (cur === p.id ? null : cur))
            }
            onFocus={() => setHovered(p.id)}
            onBlur={() => setHovered((cur) => (cur === p.id ? null : cur))}
            title={p.page_title}
          >
            <span
              className="ofb-heat-dot block h-3 w-3 rounded-full border-2 border-white shadow"
              style={{ background: "rgba(239,68,68,0.95)" }}
            />
            {hovered === p.id && (
              <span
                className="absolute left-4 top-0 z-10 w-48 rounded-lg border border-black/20 bg-white p-1.5 text-[11px] leading-snug text-black shadow-lg"
                style={{ pointerEvents: "none" }}
              >
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.image_url}
                    alt=""
                    className="mb-1 block aspect-video w-full rounded object-cover"
                    draggable={false}
                  />
                ) : null}
                <span className="block truncate font-medium">
                  {p.page_title}
                </span>
                <span className="block text-[10px] opacity-60">
                  jump to page
                </span>
              </span>
            )}
          </a>
        ))}
      </div>

      {state.status === "loading" && (
        <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
          loading taps…
        </span>
      )}
      {state.status === "ready" && points.length === 0 && (
        <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
          no taps yet
        </span>
      )}
    </div>
  );
}
