"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import type {
  Citation,
  GenerateRequestBody,
  GenerateEvent,
  MapCrop,
  ObserverPose,
  SceneView,
  ViewLevel,
  WorldEntityGeo,
} from "@openflipbook/config";
import {
  annotateClickPoint,
  annotateStroke,
  normalizeClickOnImage,
  summarizeStroke,
  type NormalizedClick,
} from "@/lib/image-click";
import {
  getWSUrl,
  startLTXStream,
  type StreamClient,
  type StreamStatus,
} from "@/lib/stream-client";
import WorldMap from "@/components/world-map";
import DebugHud from "@/components/debug-hud";
import SessionMinimap from "@/components/session-minimap";
import WaterfallHUD from "@/components/waterfall-hud";
import NeighbourTray from "@/components/PlayPage/NeighbourTray";
import CitationsChip from "@/components/citations-chip";
import TimeScrubber from "@/components/time-scrubber";
import {
  TRACE_HEADER,
  emit as hudEmit,
  newTraceId,
  nowMs,
} from "@/lib/trace";
import { getStrings, resolveOutputLocale } from "@/lib/i18n";
import { useImageTier, useVideoTier } from "@/hooks/usePersistedTier";
import { useExpandBloom } from "@/hooks/useExpandBloom";
import { buildConditionRefs, orderedRefs } from "@/lib/image-condition";
import { enterAsToRenderMode, findRevisitTarget } from "@/lib/world-mode";
import { usePersistedLocale } from "@/hooks/usePersistedLocale";
import { usePersistedTheme } from "@/hooks/usePersistedTheme";
import { useStyleAnchor } from "@/hooks/useStyleAnchor";
import { useWorldMode } from "@/hooks/useWorldMode";
import { useStyleGalleryDismissed } from "@/hooks/useStyleGalleryDismissed";
import { useTraceEmitter } from "@/hooks/useTraceEmitter";
import { QueryToolbar } from "@/components/PlayPage/QueryToolbar";
import { StyleGallery } from "@/components/PlayPage/StyleGallery";
import { FirstRunCoach } from "@/components/PlayPage/FirstRunCoach";
import { BloomGlyph } from "@/components/PlayPage/BloomGlyph";
import { MorphImagePair } from "@/components/PlayPage/MorphImagePair";
import { StrokeOverlay } from "@/components/PlayPage/StrokeOverlay";
import { ClickRipple } from "@/components/PlayPage/ClickRipple";
import { BranchBeacons } from "@/components/PlayPage/BranchBeacons";
import { GeneratingBanner } from "@/components/PlayPage/GeneratingBanner";
import { Quickbar } from "@/components/PlayPage/Quickbar";
import { HelpOverlay } from "@/components/PlayPage/HelpOverlay";
import { CodexPanel } from "@/components/PlayPage/CodexPanel";
import GeometryOverlay from "@/components/PlayPage/GeometryOverlay";
import WorldMiniMap from "@/components/PlayPage/WorldMiniMap";
import ClickDetailPopover, {
  type ClickDetailResult,
} from "@/components/PlayPage/ClickDetailPopover";
import Breadcrumb from "@/components/PlayPage/Breadcrumb";
import SpatialPath from "@/components/PlayPage/SpatialPath";
import { buildBreadcrumb } from "@/lib/breadcrumb";
import { EntityHoverOverlay } from "@/components/PlayPage/EntityHoverOverlay";
import { ContextMenu } from "@/components/PlayPage/ContextMenu";
import { HoverCrosshair } from "@/components/PlayPage/HoverCrosshair";
import { HintPrompt } from "@/components/PlayPage/HintPrompt";
import { EditForm } from "@/components/PlayPage/EditForm";
import { ImageFailedOverlay } from "@/components/PlayPage/ImageFailedOverlay";
import { DragDropOverlay } from "@/components/PlayPage/DragDropOverlay";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useWorldState } from "@/hooks/useWorldState";
import { useWorldMap } from "@/hooks/useWorldMap";
import { geoTapRequest, type GeoTapOverride } from "@/lib/geo-tap";
import { viewNeutralAppearance } from "@/lib/appearance";
import { useImageMorph } from "@/hooks/useImageMorph";
import {
  PREFETCH_LRU_MAX,
  PREFETCH_PER_PAGE,
  usePrefetchCache,
} from "@/hooks/usePrefetchCache";

type Phase = "idle" | "generating" | "ready" | "error";

interface Page {
  nodeId: string | null;
  sessionId: string;
  query: string;
  title: string;
  imageDataUrl: string | null;
  // Set when this page was generated as a child of another via a tap.
  parentId?: string | null;
  // Where the user clicked on the parent page (0..1). Used by the map
  // view to position the child tile inside the parent's rect.
  clickInParent?: { xPct: number; yPct: number };
  // Web-search citations the planner used. Hydrated from the SSE final
  // event and from /api/nodes/[id] on permalink replay. Empty when web
  // search returned nothing or is disabled.
  sources?: Citation[];
  // The view this page was entered from (geo tap). Its focus_id scopes the
  // minimap to the place you're inside; null/absent on the world map + classic
  // pages → the minimap shows the whole world frame.
  sceneView?: SceneView | null;
}

function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `session_${crypto.randomUUID()}`;
  }
  return `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function initialSessionId(): string {
  if (typeof window === "undefined") return newSessionId();
  const cont = new URLSearchParams(window.location.search).get("continue");
  return cont && cont.trim() ? cont.trim() : newSessionId();
}

interface PersistBody {
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_data_url: string;
  image_model: string;
  prompt_author_model: string;
  aspect_ratio: string;
  final_prompt: string;
  click_in_parent?: { x_pct: number; y_pct: number } | null;
  sources?: { url: string; title: string | null }[] | null;
  relation?: "descend" | "expand";
  scale?: "component" | "peer" | "container";
  scene_view?: SceneView | null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("unexpected file read result"));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
}

async function persistNode(
  body: PersistBody,
  traceId: string | null
): Promise<{ id: string; image_url: string } | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (traceId) headers[TRACE_HEADER] = traceId;
    const res = await fetch("/api/nodes", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as { id: string; image_url: string };
  } catch {
    return null;
  }
}

// Fire-and-forget extraction trigger. The world-memory pass runs on the
// modal backend (one VLM call) and the diff is merged into Mongo by
// /api/world/[sessionId]/extract. Off the critical path: failure here
// is silent — the codex just stays thinner this turn. The HUD emits a
// span so latency + cache hits land on the perf timeline.
//
// `caption` is the page title (≤8 words). `sceneDescription` is the
// planner's `final_prompt` — the rich paragraph the image model rendered
// from. The VLM needs both to reliably name entities; a title alone is
// usually too thin ("Lantern Room" without the keeper's name in scope).
function triggerExtraction(args: {
  sessionId: string;
  nodeId: string;
  imageDataUrl: string;
  caption: string;
  sceneDescription?: string | null;
  // The view this node renders (geo-tap intent). When it carries a focus_id, the
  // extract route seeds this scene's sub-entities into that place's child frame.
  sceneView?: SceneView | null;
  traceId: string | null;
}): void {
  const t0 = nowMs();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (args.traceId) headers[TRACE_HEADER] = args.traceId;
  void fetch(
    `/api/world/${encodeURIComponent(args.sessionId)}/extract`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        node_id: args.nodeId,
        image_data_url: args.imageDataUrl,
        caption: args.caption,
        scene_description: args.sceneDescription ?? null,
        scene_view: args.sceneView ?? null,
      }),
    }
  )
    .then(async (res) => {
      if (!res.ok) {
        hudEmit("world:extract_error", {
          status: res.status,
          trace_id: args.traceId,
          t: nowMs(),
        });
        return;
      }
      const payload = (await res.json()) as {
        added_ids?: string[];
        updated_ids?: string[];
        added_entities?: { id: string; name: string; kind: string }[];
        updated_entities?: { id: string; name: string; kind: string }[];
      };
      hudEmit("world:extracted", {
        session_id: args.sessionId,
        node_id: args.nodeId,
        added: payload.added_ids?.length ?? 0,
        updated: payload.updated_ids?.length ?? 0,
        added_entities: payload.added_entities ?? [],
        updated_entities: payload.updated_entities ?? [],
        dur_ms: Math.round(nowMs() - t0),
        trace_id: args.traceId,
        t: nowMs(),
      });
    })
    .catch(() => {
      // Best-effort. The codex view will refetch on its own if a user
      // opens it; nothing to roll back here.
    });
}

export default function PlayPage() {
  const [input, setInput] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const { morphFx, setMorphFx } = useImageMorph(page?.imageDataUrl);
  const [sessionId] = useState(initialSessionId);
  // Surface the live session id to the landing's "open last atlas" link.
  // Wrapped in a try because localStorage can throw under privacy modes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openflipbook.lastSession", sessionId);
    } catch {
      /* no-op */
    }
  }, [sessionId]);
  // `items` is the append-only graph of all known pages this session.
  // `trail` is the visited-order stack for back/forward; `trailIdx` is the
  // current pointer. Clicking on any page creates a NEW child without
  // truncating sibling branches in `items` — only the trail's forward arm
  // gets dropped (browser-style redo behavior on the visited path only).
  const [history, setHistory] = useState<{
    items: Page[];
    trail: string[];
    trailIdx: number;
  }>({
    items: [],
    trail: [],
    trailIdx: -1,
  });
  const [viewMode, setViewMode] = useState<"page" | "map">("page");
  // Expand-outward bloom: the neighbours streaming into the tray (null = no
  // bloom). Independent of the main `phase` so the focal page stays put.
  // Expand-outward bloom (own SSE loop, abort-on-close) — see useExpandBloom.
  const {
    bloom,
    start: startBloom,
    close: closeBloom,
  } = useExpandBloom(persistNode);
  // An empty bloom (VLM proposed nothing usable) shows its brief "no neighbours
  // found" message, then auto-dismisses — so the coach + Around return instead
  // of a dead tray lingering at the bottom.
  useEffect(() => {
    if (bloom?.done && bloom.items.length === 0) {
      const t = setTimeout(closeBloom, 2600);
      return () => clearTimeout(t);
    }
  }, [bloom?.done, bloom?.items.length, closeBloom]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [clickRipple, setClickRipple] = useState<{
    xPx: number;
    yPx: number;
    key: number;
  } | null>(null);
  // ⌘/Ctrl-click hint capture via an inline floating input anchored at the
  // click point. The promise resolves to the typed hint (or null on
  // cancel/Esc) so the click handler can stay a single async function.
  const [hintPrompt, setHintPrompt] = useState<{
    xPx: number;
    yPx: number;
    resolve: (text: string | null) => void;
    // World Mode semi-autonomy seeds this with the resolver's question(s).
    question?: string;
  } | null>(null);
  const promptForHint = useCallback(
    (xPx: number, yPx: number, question?: string): Promise<string | null> => {
      return new Promise((resolve) => {
        setHintPrompt({ xPx, yPx, resolve, ...(question ? { question } : {}) });
      });
    },
    []
  );
  // ⌘/Ctrl-click on a geo-enterable place → the structured "set your view"
  // popover (mounts the observer/gaze editor). Mirrors promptForHint: the
  // promise resolves to the chosen view (or null on cancel) so the click
  // handler stays one async function.
  type ClickDetailRequest = {
    xPx: number;
    yPx: number;
    entities: WorldEntityGeo[];
    crop: MapCrop;
    initial: {
      observer: ObserverPose;
      level: ViewLevel;
      focusLabel: string;
      canSubmap: boolean;
      mode: "scene" | "submap";
    };
    resolve: (r: ClickDetailResult | null) => void;
  };
  const [clickDetail, setClickDetail] = useState<ClickDetailRequest | null>(null);
  const promptForClickDetail = useCallback(
    (
      args: Omit<ClickDetailRequest, "resolve">,
    ): Promise<ClickDetailResult | null> =>
      new Promise((resolve) => setClickDetail({ ...args, resolve })),
    [],
  );
  // Morph state. The new page is rendered as a second <img> above the old
  // one, scaling from the click origin while the old layer fades. See
  // globals.css `.ec-morph-old`/`.ec-morph-new` for the animation surface.
  // `phase: "wait"` until the next image data URL is decoded; flips to
  // "reveal" when the decode-then-reveal effect resolves; cleanup on
  // transitionend → null. `reduceMotion` short-circuits to a flat opacity
  // crossfade.
  // `isFinal` separates the SSE `progress` event stream (partial JPEGs that
  // mutate page.imageDataUrl mid-generation) from the terminal `final` event.
  // Without this gate the decode-then-reveal effect would fire on the first
  // progress partial and the user would see the partial revealed full-size,
  // then a hard cut to the final image. The flag is flipped only in the SSE
  // `final` branch.
  const [quickbarOpen, setQuickbarOpen] = useState(false);
  const [quickbarQuery, setQuickbarQuery] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [codexOpen, setCodexOpen] = useState(false);
  const [geoOverlayOn, setGeoOverlayOn] = useState(false);
  // In-image entity chips are opt-in to keep the rendered illustration
  // visually quiet by default. Toggle alongside the codex pill (Alt-K
  // would conflict with keyboard tab-order; we expose a small toggle
  // inside the codex header instead). Persisted only in component state.
  const [entityChipsEnabled, setEntityChipsEnabled] = useState(false);
  const [scrubberOpen, setScrubberOpen] = useState(false);
  // True between an SSE `progress` (fast-tier draft) and the matching
  // `final` event. Used to overlay a subtle breathing blur so the user
  // reads the draft as in-progress, not done.
  const [progressiveDraft, setProgressiveDraft] = useState(false);
  const [beaconsHidden, setBeaconsHidden] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    xPx: number;
    yPx: number;
  } | null>(null);
  const { bindTrace } = useTraceEmitter();
  const { state: worldState, mutate: mutateWorldEntity } =
    useWorldState(sessionId);
  // Geometric world map (entity coordinates). Empty unless GEOMETRIC_WORLD seeded
  // it; drives the geometry overlay/minimap + the geometric tap (close the loop).
  const geoMap = useWorldMap(sessionId);
  // Extraction seeds the geo map AFTER the node loads, so reload it whenever the
  // codex grows (same trigger) — otherwise a tap right after a render routes
  // against a stale/empty world and the geometric path never fires.
  const geoRefetch = geoMap.refetch;
  const codexCount = worldState.entities.length;
  useEffect(() => {
    void geoRefetch();
  }, [codexCount, geoRefetch]);
  // Guard against re-entry between the click handler's synchronous
  // setMorphFx() call and React's next render that propagates
  // phase==="generating" into the click effect closure. Without this, a
  // double-click can pass the `phase === "generating"` check twice and start
  // two overlapping generates.
  const clickInFlightRef = useRef(false);
  const [hoverPos, setHoverPos] = useState<{ xPx: number; yPx: number } | null>(
    null
  );
  // Annotate-and-regenerate: when the user holds Shift and drags on the
  // image, we capture a polyline stroke. Released stroke is rendered onto a
  // copy of the parent image so the VLM sees the user's circle/arrow as
  // part of the click intent. `points` are normalised 0..1 in image space;
  // `pxPoints` mirror them in pixel space for the live SVG overlay so we
  // don't have to re-resolve sizes every frame.
  const [strokeState, setStrokeState] = useState<{
    points: NormalizedClick[];
    pxPoints: { x: number; y: number }[];
  } | null>(null);
  const strokeActiveRef = useRef(false);
  const strokePointsRef = useRef<NormalizedClick[]>([]);
  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<StreamClient | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus | "off">("off");
  const [fallbackVideoUrl, setFallbackVideoUrl] = useState<string | null>(null);
  // After Stop, we keep `fallbackVideoUrl` around so the user can flip back
  // to the already-generated clip without re-paying for animation. `showVideo`
  // gates whether the figure renders the video or the still image.
  const [showVideo, setShowVideo] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
    // Each page has its own clip — clear the previous page's cached fal URL
    // when the user navigates so "Replay clip" never resurfaces a stale clip.
    setFallbackVideoUrl(null);
    setShowVideo(false);
  }, [page?.imageDataUrl]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  // Persisted-preference state: render with the SSR-safe default on first
  // paint, then hydrate from localStorage in an effect. Reading localStorage
  // inside the useState initializer causes React 19 to bail out of hydration
  // on this subtree when the stored value diverges from SSR — symptom is that
  // the first click on a tier/theme button "doesn't take" until a re-render
  // settles. theme-init.js paints the correct `data-theme` on <html> before
  // hydration; the per-effect firstRun guards keep these effects from
  // overwriting that initial paint with the default values on mount.
  const [imageTier, setImageTier] = useImageTier();
  const [videoTier, setVideoTier] = useVideoTier();
  const [outputLocale, setOutputLocale] = usePersistedLocale();
  const [theme, setTheme] = usePersistedTheme();
  const t = getStrings(outputLocale);

  const [editMode, setEditMode] = useState(false);
  const [editInstruction, setEditInstruction] = useState("");

  // Style DNA lock — when the user pins a page, every subsequent generate
  // gets `session_style_anchor` set to that page's VLM-described style.
  // Hook owns load/save (keyed by sessionId) and the toggle round-trip.
  const {
    anchor: styleAnchor,
    pending: styleAnchorPending,
    togglePin,
    setFromPreset,
  } = useStyleAnchor(sessionId);
  // World Mode (per-session, off by default): a tap ENTERS the tapped place
  // instead of explaining it, and entered places persist + reopen. `autonomy`
  // chooses auto (just go) vs semi (ask a quick question first).
  const {
    enabled: worldEnabled,
    autonomy: worldAutonomy,
    setEnabled: setWorldEnabled,
    setAutonomy: setWorldAutonomy,
  } = useWorldMode(sessionId);
  const [styleGalleryDismissed, dismissStyleGallery] =
    useStyleGalleryDismissed(sessionId);
  const togglePinStyle = useCallback(
    () =>
      togglePin({
        nodeId: page?.nodeId ?? null,
        imageDataUrl: page?.imageDataUrl ?? null,
        title: page?.title ?? "",
        query: page?.query ?? null,
      }),
    [page, togglePin],
  );

  // Hover-prefetch cache. Keyed by `${nodeId}:${xBucket}:${yBucket}` so two
  // hovers within a 5% grid cell reuse the same VLM round-trip.
  //
  // Bandwidth/cost discipline (each prefetch POSTs ~1-3MB image data + spends
  // OpenRouter VLM tokens):
  //   - serial: only one in-flight request at a time; new hover aborts prior
  //   - per-page cap: at most PREFETCH_PER_PAGE distinct buckets warmed
  //   - LRU eviction at PREFETCH_LRU_MAX so long sessions don't grow Map<>
  //   - debounce 450ms below filters out fast pointer sweeps
  const {
    cacheRef: prefetchCacheRef,
    inflightRef: prefetchInflightRef,
    timerRef: prefetchTimerRef,
    currentKeyRef: prefetchCurrentKeyRef,
    perPageCountRef: prefetchPerPageCountRef,
    bucketKey,
  } = usePrefetchCache();

  const generate = useCallback(
    async (body: GenerateRequestBody) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setPhase("generating");
      setError(null);
      setStatusMsg(
        body.mode === "tap" ? "Resolving what you tapped…" : "Planning page…"
      );
      const traceId = body.trace_id ?? newTraceId();
      bindTrace(traceId, { announce: true });

      try {
        const response = await fetch("/api/generate-page", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [TRACE_HEADER]: traceId,
          },
          body: JSON.stringify({ ...body, trace_id: traceId }),
          signal: ac.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`generation failed: HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastTitle = body.query;
        let lastImage: string | null = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const line = chunk.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            const evt = JSON.parse(payload) as GenerateEvent;
            if (evt.type === "status") {
              hudEmit("sse:status", {
                stage: evt.stage,
                page_title: evt.page_title,
                subject: evt.subject,
                trace_id: traceId,
                t: nowMs(),
              });
              if (evt.stage === "click_resolved" && evt.subject) {
                setStatusMsg(`Exploring "${evt.subject}"…`);
              } else if (evt.stage === "planning") {
                setStatusMsg("Planning page…");
              } else if (evt.stage === "generating_image") {
                setStatusMsg(
                  evt.page_title
                    ? `Drawing "${evt.page_title}"…`
                    : "Drawing image…"
                );
              }
            } else if (evt.type === "progress") {
              lastImage = `data:image/jpeg;base64,${evt.jpeg_b64}`;
              setProgressiveDraft(true);
              hudEmit("sse:progress", {
                trace_id: traceId,
                t: nowMs(),
              });
              setPage((prev) => ({
                nodeId: prev?.nodeId ?? null,
                sessionId: body.session_id,
                query: body.query,
                title: lastTitle,
                imageDataUrl: lastImage,
              }));
            } else if (evt.type === "final") {
              lastImage = evt.image_data_url;
              lastTitle = evt.page_title;
              const evtSources: Citation[] = Array.isArray(evt.sources)
                ? evt.sources
                : [];
              hudEmit("sse:final", {
                page_title: evt.page_title,
                image_model: evt.image_model,
                trace_id: traceId,
                t: nowMs(),
              });
              setProgressiveDraft(false);
              setPage({
                nodeId: null,
                sessionId: evt.session_id,
                query: body.query,
                title: evt.page_title,
                imageDataUrl: evt.image_data_url,
                sources: evtSources,
              });
              // Flip the morph gate so the decode-then-reveal effect runs
              // ONLY on the final image, not on streamed progress partials.
              setMorphFx((prev) => (prev ? { ...prev, isFinal: true } : prev));
              void persistNode(
                {
                  parent_id: body.current_node_id || null,
                  session_id: evt.session_id,
                  query: body.query,
                  page_title: evt.page_title,
                  image_data_url: evt.image_data_url,
                  image_model: evt.image_model,
                  prompt_author_model: evt.prompt_author_model,
                  aspect_ratio: body.aspect_ratio,
                  final_prompt: evt.final_prompt,
                  click_in_parent:
                    body.mode === "tap" && body.click
                      ? {
                          x_pct: body.click.x_pct,
                          y_pct: body.click.y_pct,
                        }
                      : null,
                  sources: evtSources.map((s) => ({
                    url: s.url,
                    title: s.title ?? null,
                  })),
                  scene_view: body.scene_view ?? null,
                },
                traceId
              ).then((saved) => {
                if (saved) {
                  const persisted: Page = {
                    nodeId: saved.id,
                    sessionId: evt.session_id,
                    query: body.query,
                    title: evt.page_title,
                    imageDataUrl: evt.image_data_url,
                    parentId: body.current_node_id || null,
                    sources: evtSources,
                    sceneView: body.scene_view
                      ? { ...body.scene_view, node_id: saved.id }
                      : null,
                    ...(body.mode === "tap" && body.click
                      ? {
                          clickInParent: {
                            xPct: body.click.x_pct,
                            yPct: body.click.y_pct,
                          },
                        }
                      : {}),
                  };
                  setPage((prev) =>
                    prev
                      ? {
                          ...prev,
                          nodeId: saved.id,
                          sceneView: body.scene_view
                            ? { ...body.scene_view, node_id: saved.id }
                            : null,
                        }
                      : prev
                  );
                  const newId = saved.id;
                  setHistory((prev) => {
                    const existingIdx = prev.items.findIndex(
                      (p) => p.nodeId === newId
                    );
                    const items =
                      existingIdx >= 0
                        ? prev.items.map((p, i) =>
                            i === existingIdx ? persisted : p
                          )
                        : [...prev.items, persisted];
                    const trail = [
                      ...prev.trail.slice(0, prev.trailIdx + 1),
                      newId,
                    ];
                    return { items, trail, trailIdx: trail.length - 1 };
                  });
                  const url = new URL(window.location.href);
                  url.pathname = `/n/${saved.id}`;
                  window.history.replaceState({}, "", url.toString());
                  triggerExtraction({
                    sessionId: evt.session_id,
                    nodeId: saved.id,
                    imageDataUrl: evt.image_data_url,
                    caption: evt.page_title,
                    sceneDescription: evt.final_prompt ?? null,
                    sceneView: body.scene_view
                      ? { ...body.scene_view, node_id: saved.id }
                      : null,
                    traceId,
                  });
                }
              });
            } else if (evt.type === "error") {
              hudEmit("sse:error", {
                message: evt.message,
                trace_id: traceId,
                t: nowMs(),
              });
              throw new Error(evt.message);
            }
          }
        }
        setPhase("ready");
        setStatusMsg(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setMorphFx(null);
          setProgressiveDraft(false);
          return;
        }
        setError((err as Error).message);
        setPhase("error");
        setMorphFx(null);
        setProgressiveDraft(false);
        // Best-effort error sink so /status's "recent errors" panel can
        // surface client-side failures alongside backend ones.
        void fetch("/api/errors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [TRACE_HEADER]: traceId,
          },
          body: JSON.stringify({
            kind: "client.generate",
            message: (err as Error).message,
            stack: (err as Error).stack,
            trace_id: traceId,
            source: "client",
          }),
        }).catch(() => {});
      }
    },
    []
  );

  // Build the expand body from the current page + session state and hand it to
  // the bloom hook (which owns the SSE loop, tray state, persistence + abort).
  const triggerExpand = useCallback(() => {
    if (!page || !page.imageDataUrl || phase === "generating") return;
    if (bloom && !bloom.done) return;
    // Image conditioning: every neighbour shares the parent's world + the
    // session anchor so the bloom reads as one place. No region crop — expand
    // is whole-page outward (directional edge-crops are a later phase).
    const anchorImage =
      history.items.find((p) => p.parentId == null)?.imageDataUrl ?? null;
    const condition = orderedRefs({
      parent: page.imageDataUrl,
      anchor: anchorImage !== page.imageDataUrl ? anchorImage : null,
    });
    startBloom({
      query: page.query,
      aspect_ratio: "16:9",
      web_search: false,
      session_id: page.sessionId,
      current_node_id: page.nodeId ?? "",
      mode: "expand",
      image: page.imageDataUrl,
      parent_query: page.query,
      parent_title: page.title,
      image_tier: imageTier,
      output_locale: resolveOutputLocale(outputLocale),
      ...(condition.urls.length
        ? {
            condition_image_urls: condition.urls,
            condition_roles: condition.roles,
          }
        : {}),
      ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
    });
  }, [
    page,
    phase,
    bloom,
    startBloom,
    imageTier,
    outputLocale,
    styleAnchor,
    history,
  ]);

  const acceptUploadedImage = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        setError("Only image files can be used as a seed page.");
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const seedTitle = "Uploaded image";
        const seedQuery = "Uploaded image";
        setPage({
          nodeId: null,
          sessionId,
          query: seedQuery,
          title: seedTitle,
          imageDataUrl: dataUrl,
        });
        setPhase("ready");
        setError(null);
        setStatusMsg(null);
        const uploadTrace = newTraceId();
        bindTrace(uploadTrace);
        void persistNode(
          {
            parent_id: null,
            session_id: sessionId,
            query: seedQuery,
            page_title: seedTitle,
            image_data_url: dataUrl,
            image_model: "user-upload",
            prompt_author_model: "user-upload",
            aspect_ratio: "16:9",
            final_prompt: "",
          },
          uploadTrace
        ).then((saved) => {
          if (saved) {
            const persisted: Page = {
              nodeId: saved.id,
              sessionId,
              query: seedQuery,
              title: seedTitle,
              imageDataUrl: dataUrl,
              parentId: null,
            };
            setPage((prev) => (prev ? { ...prev, nodeId: saved.id } : prev));
            const newId = saved.id;
            setHistory((prev) => {
              const existingIdx = prev.items.findIndex(
                (p) => p.nodeId === newId
              );
              const items =
                existingIdx >= 0
                  ? prev.items.map((p, i) =>
                      i === existingIdx ? persisted : p
                    )
                  : [...prev.items, persisted];
              const trail = [
                ...prev.trail.slice(0, prev.trailIdx + 1),
                newId,
              ];
              return { items, trail, trailIdx: trail.length - 1 };
            });
            const url = new URL(window.location.href);
            url.pathname = `/n/${saved.id}`;
            window.history.replaceState({}, "", url.toString());
            triggerExtraction({
              sessionId,
              nodeId: saved.id,
              imageDataUrl: dataUrl,
              caption: seedTitle,
              traceId: uploadTrace,
            });
          }
        });
      } catch (err) {
        setError((err as Error).message);
        setPhase("error");
      }
    },
    [sessionId, bindTrace]
  );

  const onFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void acceptUploadedImage(file);
      e.target.value = "";
    },
    [acceptUploadedImage]
  );

  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (Array.from(e.dataTransfer.items).some((it) => it.kind === "file")) {
      e.preventDefault();
      setIsDraggingFile(true);
    }
  }, []);

  const onDragLeave = useCallback(() => setIsDraggingFile(false), []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setIsDraggingFile(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void acceptUploadedImage(file);
    },
    [acceptUploadedImage]
  );

  const submitQuery = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const q = input.trim();
      if (!q) return;
      void generate({
        query: q,
        aspect_ratio: "16:9",
        web_search: true,
        session_id: sessionId,
        current_node_id: page?.nodeId ?? "",
        mode: "query",
        image_tier: imageTier,
        output_locale: resolveOutputLocale(outputLocale),
        ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
      });
    },
    [input, sessionId, page, generate, imageTier, outputLocale, styleAnchor]
  );

  const submitEdit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const instruction = editInstruction.trim();
      if (!instruction || !page?.imageDataUrl) return;
      void generate({
        query: instruction,
        aspect_ratio: "16:9",
        web_search: false,
        session_id: page.sessionId,
        current_node_id: page.nodeId ?? "",
        mode: "edit",
        image: page.imageDataUrl,
        edit_instruction: instruction,
        parent_query: page.query,
        parent_title: page.title,
        image_tier: imageTier,
        output_locale: resolveOutputLocale(outputLocale),
        ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
      });
      setEditInstruction("");
      setEditMode(false);
    },
    [editInstruction, page, generate, imageTier, outputLocale, styleAnchor]
  );

  const canGoBack = history.trailIdx > 0;
  const canGoForward = history.trailIdx < history.trail.length - 1;
  // Where-am-I trail (root … current) — clicking an ancestor jumps straight
  // back to it (the leftmost crumb is the map you started from).
  const breadcrumb = useMemo(
    () => buildBreadcrumb(page?.nodeId ?? null, history.items),
    [page?.nodeId, history.items],
  );

  const navigateToTrailIdx = (
    prev: typeof history,
    nextIdx: number
  ): typeof history => {
    const id = prev.trail[nextIdx];
    if (!id) return prev;
    const target = prev.items.find((p) => p.nodeId === id);
    if (!target) return prev;
    setPage(target);
    setPhase("ready");
    setError(null);
    setStatusMsg(null);
    setMorphFx(null);
    abortRef.current?.abort();
    if (target.nodeId) {
      const url = new URL(window.location.href);
      url.pathname = `/n/${target.nodeId}`;
      window.history.replaceState({}, "", url.toString());
    }
    return { ...prev, trailIdx: nextIdx };
  };

  const goBack = useCallback(() => {
    setHistory((prev) =>
      prev.trailIdx <= 0 ? prev : navigateToTrailIdx(prev, prev.trailIdx - 1)
    );
  }, []);

  const goForward = useCallback(() => {
    setHistory((prev) =>
      prev.trailIdx >= prev.trail.length - 1
        ? prev
        : navigateToTrailIdx(prev, prev.trailIdx + 1)
    );
  }, []);

  const selectFromMap = useCallback((nodeId: string) => {
    setHistory((prev) => {
      const target = prev.items.find((p) => p.nodeId === nodeId);
      if (!target) return prev;
      setPage(target);
      setPhase("ready");
      setError(null);
      setStatusMsg(null);
      setMorphFx(null);
      abortRef.current?.abort();
      if (target.nodeId) {
        const url = new URL(window.location.href);
        url.pathname = `/n/${target.nodeId}`;
        window.history.replaceState({}, "", url.toString());
      }
      // Append to trail (truncating forward) so back/forward walks the
      // visited path even after a map jump.
      const trail = [
        ...prev.trail.slice(0, prev.trailIdx + 1),
        nodeId,
      ];
      return { ...prev, trail, trailIdx: trail.length - 1 };
    });
    setViewMode("page");
  }, []);

  useKeyboardShortcuts({
    onBack: goBack,
    onForward: goForward,
    onToggleMap: () => setViewMode((m) => (m === "map" ? "page" : "map")),
    onToggleScrubber: () => setScrubberOpen((s) => !s),
    onOpenQuickbar: () => setQuickbarOpen(true),
    onToggleHelp: () => setHelpOpen((h) => !h),
    onToggleCodex: () => setCodexOpen((c) => !c),
    onExpandOutward: triggerExpand,
    onCloseOverlays: () => {
      setHelpOpen(false);
      setQuickbarOpen(false);
      setContextMenu(null);
      setCodexOpen(false);
    },
    anyOverlayOpen:
      helpOpen || quickbarOpen || codexOpen || contextMenu !== null,
  });

  // Hydrate the session graph from the server when landing with ?continue=.
  // Pages are sorted by created_at on the server (see listNodesBySession).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (typeof window === "undefined") return;
    const cont = new URLSearchParams(window.location.search)
      .get("continue")
      ?.trim();
    if (!cont) return;
    hydratedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const hydrationTrace = newTraceId();
        bindTrace(hydrationTrace);
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(cont)}`,
          { headers: { [TRACE_HEADER]: hydrationTrace } }
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          nodes: Array<{
            id: string;
            parent_id: string | null;
            session_id: string;
            query: string;
            page_title: string;
            image_url: string;
            click_in_parent: { x_pct: number; y_pct: number } | null;
            sources?: { url: string; title: string | null }[] | null;
            scene_view?: SceneView | null;
          }>;
        };
        if (cancelled) return;
        if (!data.nodes?.length) return;
        const items: Page[] = data.nodes.map((n) => ({
          nodeId: n.id,
          sessionId: n.session_id,
          query: n.query,
          title: n.page_title,
          imageDataUrl: n.image_url,
          parentId: n.parent_id,
          sources: Array.isArray(n.sources) ? n.sources : [],
          sceneView: n.scene_view ?? null,
          ...(n.click_in_parent
            ? {
                clickInParent: {
                  xPct: n.click_in_parent.x_pct,
                  yPct: n.click_in_parent.y_pct,
                },
              }
            : {}),
        }));
        const last = items[items.length - 1];
        const trail = last && last.nodeId ? [last.nodeId] : [];
        setHistory({ items, trail, trailIdx: trail.length - 1 });
        if (last) {
          setPage(last);
          setPhase("ready");
        }
      } catch {
        // best-effort hydration; user can still click around
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Release the click re-entry guard whenever generation settles into a
  // terminal state. `phase` is the canonical signal; abort/cancel paths
  // also land here via setPhase calls.
  useEffect(() => {
    if (phase !== "generating") {
      clickInFlightRef.current = false;
    }
  }, [phase]);

  // Pre-resolve the 3-4 most click-worthy regions on the freshly rendered
  // page. Pumps each candidate into prefetchCacheRef so clicks landing near
  // them skip the VLM call. Runs once per nodeId. Disabled if the page lacks
  // a stable nodeId (in-progress generation) — without a nodeId the bucket
  // key is "noid" and would collide across pages.
  const precomputedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (phase !== "ready") return;
    if (!page?.imageDataUrl || !page.nodeId) return;
    if (page.imageDataUrl.startsWith("http") && !page.imageDataUrl.startsWith("data:")) {
      // Persisted images served from R2 are also fine — backend accepts URLs
      // via the image-data-url field, but the precompute endpoint needs a
      // data URL. Skip until we add http handling there.
      // (Continuing past this in case of data: URL.)
    }
    const nodeId = page.nodeId;
    if (precomputedRef.current.has(nodeId)) return;
    precomputedRef.current.add(nodeId);
    const ac = new AbortController();
    const controller = ac;
    void (async () => {
      try {
        // Backend expects a data URL; if the page was hydrated from R2 we
        // skip — those pages already have whatever VLM context the user's
        // prior session built up, and re-fetching them would be wasteful.
        if (!page.imageDataUrl?.startsWith("data:")) return;
        const trace = newTraceId();
        const res = await fetch("/api/precompute-candidates", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [TRACE_HEADER]: trace,
          },
          body: JSON.stringify({
            image_data_url: page.imageDataUrl,
            parent_title: page.title,
            parent_query: page.query,
            output_locale: resolveOutputLocale(outputLocale),
            // 8 candidates × tighter bucket grid = most taps land in the cache.
            max_candidates: 8,
          }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          candidates?: {
            x_pct: number;
            y_pct: number;
            subject: string;
            style: string;
            salience: number;
          }[];
        };
        if (!Array.isArray(data.candidates)) return;
        const cache = prefetchCacheRef.current;
        const counts = prefetchPerPageCountRef.current;
        const scope = nodeId;
        for (const c of data.candidates) {
          if ((counts.get(scope) ?? 0) >= PREFETCH_PER_PAGE) break;
          const key = bucketKey(nodeId, c.x_pct, c.y_pct);
          if (cache.has(key)) continue;
          cache.set(key, { subject: c.subject, style: c.style });
          counts.set(scope, (counts.get(scope) ?? 0) + 1);
          // LRU evict oldest entries when we exceed the global cap.
          if (cache.size > PREFETCH_LRU_MAX) {
            const oldestKey = cache.keys().next().value;
            if (typeof oldestKey === "string") cache.delete(oldestKey);
          }
        }
        hudEmit("precompute:candidates", {
          node_id: nodeId,
          count: data.candidates.length,
          trace_id: trace,
          t: nowMs(),
        });
      } catch {
        // Best-effort — clicks fall back to on-demand resolution.
      }
    })();
    return () => {
      ac.abort();
    };
  }, [
    phase,
    page?.imageDataUrl,
    page?.nodeId,
    page?.title,
    page?.query,
    outputLocale,
    bucketKey,
  ]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !page?.imageDataUrl) return;
    const currentImage = page.imageDataUrl;
    const currentNodeId = page.nodeId;
    const cache = prefetchCacheRef.current;
    const inflight = prefetchInflightRef.current;

    const pageBucketCounts = prefetchPerPageCountRef.current;
    const pageScope = currentNodeId ?? "noid";

    const firePrefetch = (xPct: number, yPct: number) => {
      const key = bucketKey(currentNodeId, xPct, yPct);
      if (prefetchCurrentKeyRef.current === key) return;
      prefetchCurrentKeyRef.current = key;
      if (cache.has(key)) return;
      if ((pageBucketCounts.get(pageScope) ?? 0) >= PREFETCH_PER_PAGE) return;
      // Serial: cancel any prior in-flight prefetch — only the latest hover
      // is interesting, and parallel multi-MB POSTs are the cost we're
      // worried about most.
      inflight.forEach((ac) => ac.abort());
      inflight.clear();
      const ac = new AbortController();
      inflight.set(key, ac);
      pageBucketCounts.set(
        pageScope,
        (pageBucketCounts.get(pageScope) ?? 0) + 1
      );
      void (async () => {
        try {
          const res = await fetch("/api/resolve-click", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image_data_url: currentImage,
              x_pct: xPct,
              y_pct: yPct,
              parent_title: page.title,
              parent_query: page.query,
              output_locale: resolveOutputLocale(outputLocale),
            }),
            signal: ac.signal,
          });
          if (!res.ok) return;
          const data = (await res.json()) as {
            subject?: string;
            style?: string;
            subject_context?: string;
            groundable?: boolean;
            confidence?: number;
            point?: { x: number; y: number } | null;
            bbox?: { x: number; y: number; w: number; h: number } | null;
          };
          if (data.subject) {
            cache.set(key, {
              subject: data.subject,
              style: data.style ?? "",
              subject_context: data.subject_context ?? "",
              ...(typeof data.groundable === "boolean"
                ? { groundable: data.groundable }
                : {}),
              ...(typeof data.confidence === "number"
                ? { confidence: data.confidence }
                : {}),
              ...(data.point ? { point: data.point } : {}),
              ...(data.bbox ? { bbox: data.bbox } : {}),
            });
            // Bound the cache so a long session doesn't grow Map<> forever.
            // FIFO eviction is fine — cache entries are independent.
            while (cache.size > PREFETCH_LRU_MAX) {
              const oldest = cache.keys().next().value;
              if (oldest === undefined) break;
              cache.delete(oldest);
            }
          }
        } catch {
          // Best-effort. Click handler will fall back to the in-band VLM.
        } finally {
          inflight.delete(key);
        }
      })();
    };

    // World Mode "semi": a blocking click resolve so we can ask the model's
    // clarifying questions before entering. Returns the parsed payload or null.
    const resolveClickRemote = async (
      xPct: number,
      yPct: number
    ): Promise<{
      subject?: string;
      style?: string;
      subject_context?: string;
      enter_as?: string;
      clarifiers?: string[];
      surroundings?: string;
    } | null> => {
      try {
        const res = await fetch("/api/resolve-click", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_data_url: currentImage,
            x_pct: xPct,
            y_pct: yPct,
            parent_title: page.title,
            parent_query: page.query,
            output_locale: resolveOutputLocale(outputLocale),
            world_mode: true,
            autonomy: "semi",
          }),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const handler = async (evt: MouseEvent) => {
      if (phase === "generating") return;
      if (editMode) return;
      if (clickInFlightRef.current) return;
      // Stroke release also fires `click` — suppress so we don't generate
      // twice. The stroke handler already kicked off a generate.
      if (strokeActiveRef.current) {
        strokeActiveRef.current = false;
        return;
      }
      const click = normalizeClickOnImage(evt, img);
      if (!click) return;
      // Claim the slot synchronously before any await — protects the window
      // between setMorphFx and React installing a new effect with
      // phase==="generating".
      clickInFlightRef.current = true;
      // World Mode: a plain re-tap near an already-entered spot REOPENS that
      // saved place instead of generating a new one — the persistence that
      // makes the atlas read as one continuous world.
      if (worldEnabled && !evt.metaKey && !evt.ctrlKey) {
        const revisitId = findRevisitTarget(
          history.items,
          currentNodeId,
          click
        );
        if (revisitId) {
          clickInFlightRef.current = false;
          selectFromMap(revisitId);
          return;
        }
      }
      // ⌘/Ctrl + click → float an inline hint input at the click point
      // and await the user's note (or null on cancel). Captured before any
      // ripple/morph state so the bubble is the first thing they see; on
      // cancel we release the in-flight slot so the next click is honored.
      let hint = "";
      // The user's set-your-view override from the click-detail popover (if any).
      let geoOverride: GeoTapOverride | undefined;
      // World Mode "semi": resolve the tap up front and, when the model has
      // clarifying questions, ask them in the hint bubble before entering.
      let worldResolved:
        | {
            subject?: string;
            style?: string;
            subject_context?: string;
            enter_as?: string;
            clarifiers?: string[];
            surroundings?: string;
          }
        | null = null;
      if (
        worldEnabled &&
        worldAutonomy === "semi" &&
        !evt.metaKey &&
        !evt.ctrlKey
      ) {
        worldResolved = await resolveClickRemote(click.x_pct, click.y_pct);
        const questions = (worldResolved?.clarifiers ?? []).join("  ·  ");
        if (questions) {
          const rect = img.getBoundingClientRect();
          const raw = await promptForHint(
            evt.clientX - rect.left,
            evt.clientY - rect.top,
            questions
          );
          if (raw === null) {
            clickInFlightRef.current = false;
            return;
          }
          hint = raw;
        }
      } else if (evt.metaKey || evt.ctrlKey) {
        const rect = img.getBoundingClientRect();
        const px2 = evt.clientX - rect.left;
        const py2 = evt.clientY - rect.top;
        // On a geo-enterable place, open the structured "set your view" popover
        // (mounts the observer/gaze editor); otherwise keep the plain hint bubble.
        const previewTap =
          worldEnabled && geoMap.entities.length > 0
            ? geoTapRequest(
                { entities: geoMap.entities, bounds: geoMap.bounds },
                page.nodeId ?? "",
                click,
                16 / 9,
              )
            : null;
        const previewObserver = previewTap?.scene_view.observer ?? null;
        if (previewTap && previewObserver) {
          // Frame the editor on the camera↔place axis (not the whole city).
          const focusEnt = geoMap.entities.find((e) => e.id === previewTap.focus_id);
          const fx = focusEnt?.pos.x ?? previewObserver.pos.x;
          const fy = focusEnt?.pos.y ?? previewObserver.pos.y;
          const cx = (previewObserver.pos.x + fx) / 2;
          const cy = (previewObserver.pos.y + fy) / 2;
          const span = Math.max(
            Math.abs(previewObserver.pos.x - fx),
            Math.abs(previewObserver.pos.y - fy),
            focusEnt?.footprint.w ?? 10,
          ) * 2.5;
          const editorCrop: MapCrop = {
            x: cx - span / 2,
            y: cy - span / 2,
            w: span,
            h: span,
          };
          const detail = await promptForClickDetail({
            xPx: px2,
            yPx: py2,
            entities: previewTap.layout_entities,
            crop: editorCrop,
            initial: {
              observer: previewObserver,
              level: previewTap.scene_view.level,
              focusLabel: previewTap.focus_label ?? "here",
              canSubmap: false,
              mode: "scene",
            },
          });
          if (detail === null) {
            clickInFlightRef.current = false;
            return;
          }
          hint = detail.note;
          geoOverride = { observer: detail.observer, level: detail.level };
        } else {
          const raw = await promptForHint(px2, py2);
          if (raw === null) {
            clickInFlightRef.current = false;
            return;
          }
          hint = raw;
        }
      }
      const rect = img.getBoundingClientRect();
      const px = evt.clientX - rect.left;
      const py = evt.clientY - rect.top;
      setClickRipple({ xPx: px, yPx: py, key: Date.now() });
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setMorphFx({
        ox: px,
        oy: py,
        prevImg: currentImage,
        nextImg: null,
        phase: "wait",
        isFinal: false,
        startedAt: nowMs(),
        reduceMotion,
      });
      hudEmit("morph:start", { ox: px, oy: py, t: nowMs() });
      let annotated = currentImage;
      try {
        annotated = await annotateClickPoint(
          currentImage,
          click.x_pct,
          click.y_pct
        );
      } catch {
        // Fall back to the raw image + numeric coords if canvas taint or
        // decode failed. VLM still gets the text coords as a hint.
      }
      // Skip the prefetched-subject shortcut when a hint is present — the
      // hover prefetch was resolved without the user's note, so it would
      // ignore the angle they just typed.
      // In World Mode we skip the hover-prefetch shortcut so the backend always
      // classifies the tap (scene / sub-map / explainer) and frames the page.
      const cached =
        hint || worldEnabled
          ? undefined
          : cache.get(bucketKey(currentNodeId, click.x_pct, click.y_pct));
      // Image conditioning: build the weighted reference stack from the CLEAN
      // parent (not the marker-annotated one) — region crop at the tap → whole
      // parent → session root as the anti-drift anchor (skipped when this page
      // *is* the root). Best-effort; on failure we send nothing → text-only.
      const anchorImage =
        history.items.find((p) => p.parentId == null)?.imageDataUrl ?? null;
      let condition = { urls: [] as string[], roles: [] as string[] };
      try {
        condition = await buildConditionRefs({
          parentDataUrl: currentImage,
          anchorDataUrl: anchorImage !== currentImage ? anchorImage : null,
          click: { xPct: click.x_pct, yPct: click.y_pct },
        });
      } catch {
        // leave condition empty → text-only generation
      }
      // Close the geometric loop: a tap on the seeded world map → an observer
      // pose + the projected layout, so the entered scene is steered and
      // grounded by where the entities actually are. Only when World Mode is on
      // AND the geo world is seeded; null falls back to the existing World Mode
      // path. generate.py acts on these only under WORLD_GEOMETRY_GEN /
      // VLM_GROUNDING, so sending them is otherwise inert.
      const geoTap =
        worldEnabled && geoMap.entities.length > 0
          ? geoTapRequest(
              { entities: geoMap.entities, bounds: geoMap.bounds },
              page.nodeId ?? "",
              { x_pct: click.x_pct, y_pct: click.y_pct },
              16 / 9,
              geoOverride,
            )
          : null;
      void generate({
        query: page.query,
        aspect_ratio: "16:9",
        web_search: true,
        session_id: page.sessionId,
        current_node_id: page.nodeId ?? "",
        mode: "tap",
        image: annotated,
        parent_query: page.query,
        parent_title: page.title,
        click,
        image_tier: imageTier,
        output_locale: resolveOutputLocale(outputLocale),
        ...(condition.urls.length
          ? {
              condition_image_urls: condition.urls,
              condition_roles: condition.roles,
            }
          : {}),
        ...(hint ? { click_hint: hint } : {}),
        ...(cached
          ? {
              prefetched_subject: cached.subject,
              prefetched_style: cached.style,
              ...(cached.subject_context
                ? { prefetched_subject_context: cached.subject_context }
                : {}),
            }
          : {}),
        // World Mode "semi" already resolved the tap → reuse it (skips the
        // backend's own VLM round-trip) and carry the place framing.
        ...(worldResolved?.subject
          ? {
              prefetched_subject: worldResolved.subject,
              prefetched_style: worldResolved.style ?? "",
              ...(worldResolved.subject_context
                ? { prefetched_subject_context: worldResolved.subject_context }
                : {}),
            }
          : {}),
        ...(worldResolved?.surroundings
          ? { prefetched_surroundings: worldResolved.surroundings }
          : {}),
        ...(worldEnabled
          ? {
              world_mode: true,
              autonomy: worldAutonomy,
              ...(enterAsToRenderMode(worldResolved?.enter_as) !== "explainer"
                ? { render_mode: enterAsToRenderMode(worldResolved?.enter_as) }
                : {}),
            }
          : {}),
        ...(geoTap
          ? {
              scene_view: geoTap.scene_view,
              expected_layout: geoTap.expected_layout,
              // The geometric tap KNOWS which entity you hit (by coordinates) —
              // make it the subject so tapping the Tower of Art enters the Tower,
              // overriding the looser VLM read that picked its container. Spread
              // last so it wins over the cached / world-resolved subjects above.
              ...(geoTap.focus_label
                ? { prefetched_subject: geoTap.focus_label }
                : {}),
              // Anchor the entity's IDENTITY across zoom levels: feed its
              // appearance as the authoritative subject context, view-neutral so
              // it carries the materials/architecture (ancient stone, concentric
              // rings) without forcing the angle it was captured at.
              ...(viewNeutralAppearance(geoTap.focus_visual)
                ? {
                    prefetched_subject_context: viewNeutralAppearance(
                      geoTap.focus_visual,
                    ),
                  }
                : {}),
            }
          : {}),
        ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
      });
    };
    const move = (evt: PointerEvent) => {
      if (evt.pointerType === "touch") return;
      const rect = img.getBoundingClientRect();
      setHoverPos({
        xPx: evt.clientX - rect.left,
        yPx: evt.clientY - rect.top,
      });
      if (phase === "generating" || editMode) return;
      if (streamStatus !== "off") return;
      // While a stroke is active, accumulate points instead of prefetching.
      if (strokeActiveRef.current) {
        const click = normalizeClickOnImage(evt, img);
        if (!click) return;
        const last =
          strokePointsRef.current[strokePointsRef.current.length - 1];
        if (
          last &&
          Math.abs(last.x_pct - click.x_pct) < 0.005 &&
          Math.abs(last.y_pct - click.y_pct) < 0.005
        ) {
          return;
        }
        strokePointsRef.current = [...strokePointsRef.current, click];
        const px = evt.clientX - rect.left;
        const py = evt.clientY - rect.top;
        setStrokeState((prev) =>
          prev
            ? {
                points: [...prev.points, click],
                pxPoints: [...prev.pxPoints, { x: px, y: py }],
              }
            : prev
        );
        return;
      }
      const click = normalizeClickOnImage(evt, img);
      if (!click) return;
      if (prefetchTimerRef.current !== null) {
        window.clearTimeout(prefetchTimerRef.current);
      }
      prefetchTimerRef.current = window.setTimeout(() => {
        firePrefetch(click.x_pct, click.y_pct);
      }, 450);
    };
    const down = (evt: PointerEvent) => {
      if (!evt.shiftKey) return;
      if (evt.pointerType === "touch") return;
      if (phase === "generating" || editMode) return;
      if (streamStatus !== "off") return;
      const click = normalizeClickOnImage(evt, img);
      if (!click) return;
      evt.preventDefault();
      try {
        img.setPointerCapture(evt.pointerId);
      } catch {
        /* no-op */
      }
      strokeActiveRef.current = true;
      strokePointsRef.current = [click];
      const rect = img.getBoundingClientRect();
      const px = evt.clientX - rect.left;
      const py = evt.clientY - rect.top;
      setStrokeState({
        points: [click],
        pxPoints: [{ x: px, y: py }],
      });
    };
    const up = async (evt: PointerEvent) => {
      if (!strokeActiveRef.current) return;
      try {
        img.releasePointerCapture(evt.pointerId);
      } catch {
        /* no-op */
      }
      // Snapshot the stroke before clearing UI state. Read from the ref
      // because state may not have flushed since the last pointermove.
      const snapPoints = strokePointsRef.current;
      const release = () => {
        strokePointsRef.current = [];
        setStrokeState(null);
      };
      // Need at least a few points to count as a stroke; otherwise treat as
      // a Shift-click and just fall through to the regular click handler.
      if (!snapPoints || snapPoints.length < 4) {
        strokeActiveRef.current = false;
        release();
        return;
      }
      const summary = summarizeStroke(snapPoints);
      if (!summary) {
        strokeActiveRef.current = false;
        release();
        return;
      }
      // Centroid is the click anchor; suppression flag is reset inside the
      // click handler when it sees strokeActiveRef.current === true.
      const click = summary.centroid;
      if (clickInFlightRef.current) {
        strokeActiveRef.current = false;
        release();
        return;
      }
      clickInFlightRef.current = true;
      const rect2 = img.getBoundingClientRect();
      const px = click.x_pct * rect2.width;
      const py = click.y_pct * rect2.height;
      setClickRipple({ xPx: px, yPx: py, key: Date.now() });
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setMorphFx({
        ox: px,
        oy: py,
        prevImg: currentImage,
        nextImg: null,
        phase: "wait",
        isFinal: false,
        startedAt: nowMs(),
        reduceMotion,
      });
      hudEmit("morph:start", { ox: px, oy: py, t: nowMs() });
      let annotated = currentImage;
      try {
        annotated = await annotateStroke(currentImage, summary);
      } catch {
        // Fall back to the raw image; VLM still gets numeric coords.
      }
      release();
      // Stroke implies "user circled this region" — set click_hint so the
      // planner emphasises the stroked area in the next page.
      const strokeHint =
        "User circled / annotated this region with a freehand stroke. Treat the stroked area as the focus.";
      void generate({
        query: page.query,
        aspect_ratio: "16:9",
        web_search: true,
        session_id: page.sessionId,
        current_node_id: page.nodeId ?? "",
        mode: "tap",
        image: annotated,
        parent_query: page.query,
        parent_title: page.title,
        click,
        click_hint: strokeHint,
        image_tier: imageTier,
        output_locale: resolveOutputLocale(outputLocale),
        ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
      });
    };
    const leave = () => {
      setHoverPos(null);
      if (prefetchTimerRef.current !== null) {
        window.clearTimeout(prefetchTimerRef.current);
        prefetchTimerRef.current = null;
      }
      prefetchCurrentKeyRef.current = null;
    };
    img.addEventListener("click", handler);
    img.addEventListener("pointerdown", down);
    img.addEventListener("pointermove", move);
    img.addEventListener("pointerup", up);
    img.addEventListener("pointercancel", up);
    img.addEventListener("pointerleave", leave);
    return () => {
      img.removeEventListener("click", handler);
      img.removeEventListener("pointerdown", down);
      img.removeEventListener("pointermove", move);
      img.removeEventListener("pointerup", up);
      img.removeEventListener("pointercancel", up);
      img.removeEventListener("pointerleave", leave);
      if (prefetchTimerRef.current !== null) {
        window.clearTimeout(prefetchTimerRef.current);
        prefetchTimerRef.current = null;
      }
      // Abort any in-flight prefetches scoped to the previous page; cached
      // entries can stay since they're keyed by nodeId.
      inflight.forEach((ac) => ac.abort());
      inflight.clear();
      prefetchCurrentKeyRef.current = null;
    };
  }, [page, phase, generate, imageTier, editMode, outputLocale, bucketKey, streamStatus, styleAnchor, promptForHint, worldEnabled, worldAutonomy, history, selectFromMap]);

  // When the page changes, tear down any running stream.
  useEffect(() => {
    return () => {
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [page?.imageDataUrl]);

  // Auto-submit if landed here with ?q=... in the URL (deeplinks from the landing page).
  const autoSubmittedRef = useRef(false);
  useEffect(() => {
    if (autoSubmittedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q")?.trim();
    if (!q) return;
    autoSubmittedRef.current = true;
    void generate({
      query: q,
      aspect_ratio: "16:9",
      web_search: true,
      session_id: sessionId,
      current_node_id: "",
      mode: "query",
      image_tier: imageTier,
      output_locale: resolveOutputLocale(outputLocale),
      ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
    });
  }, [generate, sessionId, imageTier, outputLocale, styleAnchor]);

  const animateAbortRef = useRef<AbortController | null>(null);
  const disconnectStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    animateAbortRef.current?.abort();
    animateAbortRef.current = null;
    setStreamStatus("off");
    setShowVideo(false);
    // Intentionally NOT clearing fallbackVideoUrl here — the user can hit
    // "Replay clip" to bring it back without re-running fal.
  }, []);

  const replayVideo = useCallback(() => {
    if (!fallbackVideoUrl) return;
    setShowVideo(true);
    setStreamStatus("playing");
  }, [fallbackVideoUrl]);

  const connectStream = useCallback(async () => {
    if (!page?.imageDataUrl) return;
    const wsUrl = getWSUrl();
    if (wsUrl && videoRef.current) {
      streamRef.current?.close();
      streamRef.current = startLTXStream({
        wsUrl,
        video: videoRef.current,
        prompt: page.title,
        startImageDataUrl: page.imageDataUrl,
        onStatus: setStreamStatus,
        onError: (msg) => setError(msg),
      });
      setStreamStatus("connecting");
      return;
    }
    // Cheap fallback via fal. fal LTX video gen typically takes 30-90s; cap
    // the wait at 3 minutes so a stuck request surfaces rather than hanging
    // the UI silently.
    animateAbortRef.current?.abort();
    const ac = new AbortController();
    animateAbortRef.current = ac;
    const timeoutId = window.setTimeout(() => ac.abort(), 180_000);
    setStreamStatus("connecting");
    try {
      const res = await fetch("/api/animate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_data_url: page.imageDataUrl,
          prompt: page.title,
          video_tier: videoTier,
        }),
        signal: ac.signal,
      });
      const data = (await res.json()) as {
        video_url?: string;
        error?: string;
      };
      if (!res.ok || !data.video_url) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setFallbackVideoUrl(data.video_url);
      setShowVideo(true);
      setStreamStatus("playing");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setStreamStatus("error");
        setError("Animate timed out after 3 minutes. Try again or stop.");
      } else {
        setStreamStatus("error");
        setError((err as Error).message);
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (animateAbortRef.current === ac) animateAbortRef.current = null;
    }
  }, [page, videoTier]);

  return (
    <main
      className="relative mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 px-4 py-6"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <QueryToolbar
        t={t}
        input={input}
        onInputChange={setInput}
        onSubmit={submitQuery}
        fileInputRef={fileInputRef}
        onFileInputChange={onFileInputChange}
        busy={phase === "generating"}
        outputLocale={outputLocale}
        setOutputLocale={setOutputLocale}
        theme={theme}
        setTheme={setTheme}
        imageTier={imageTier}
        setImageTier={setImageTier}
        worldMode={worldEnabled}
        setWorldMode={setWorldEnabled}
        autonomy={worldAutonomy}
        setAutonomy={setWorldAutonomy}
      />

      {isDraggingFile && <DragDropOverlay />}

      {phase === "error" && (
        <div className="rounded-lg border border-red-500 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {page?.imageDataUrl && history.items.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Breadcrumb crumbs={breadcrumb} onJump={selectFromMap} />
          {worldEnabled && (
            <SpatialPath crumbs={breadcrumb} onNavigate={selectFromMap} />
          )}
          <div className="flex items-center justify-between gap-3 text-xs opacity-80">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goBack}
              disabled={!canGoBack}
              className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 hover:bg-[var(--color-ink)]/5 disabled:opacity-30"
              title="Go back (←)"
            >
              ← back
            </button>
            <button
              type="button"
              onClick={goForward}
              disabled={!canGoForward}
              className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 hover:bg-[var(--color-ink)]/5 disabled:opacity-30"
              title="Go forward (→)"
            >
              forward →
            </button>
            <button
              type="button"
              onClick={() => setViewMode((m) => (m === "map" ? "page" : "map"))}
              className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 hover:bg-[var(--color-ink)]/5"
              title="Toggle world map (M)"
            >
              {viewMode === "map" ? "📄 page" : "🗺 map"}
            </button>
            <a
              href={`/atlas/${encodeURIComponent(sessionId)}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 hover:bg-[var(--color-ink)]/5"
              title="Open this session's atlas in a new tab"
            >
              ↗ atlas
            </a>
          </div>
          <span className="opacity-60">
            step {history.trailIdx + 1} of {history.trail.length}
            {history.items.length > history.trail.length
              ? ` · ${history.items.length} pages explored`
              : ""}
          </span>
          </div>
        </div>
      )}

      {page?.imageDataUrl && <WaterfallHUD />}

      {page?.imageDataUrl && viewMode === "map" ? (
        <WorldMap
          pages={history.items
            .filter((p): p is Page & { nodeId: string } => Boolean(p.nodeId))
            .map((p) => ({
              nodeId: p.nodeId,
              parentId: p.parentId ?? null,
              imageDataUrl: p.imageDataUrl,
              title: p.title,
              ...(p.clickInParent ? { clickInParent: p.clickInParent } : {}),
            }))}
          activeNodeId={page?.nodeId ?? null}
          onSelect={selectFromMap}
          onClose={() => setViewMode("page")}
        />
      ) : page?.imageDataUrl ? (
        <figure
          className="relative overflow-hidden rounded-2xl border border-[var(--color-ink)]/20 bg-white shadow-lg"
          onContextMenu={(e) => {
            if (!page?.imageDataUrl) return;
            e.preventDefault();
            // ContextMenu renders inside a fixed-positioned overlay, so it
            // anchors to the viewport — pass clientX/Y directly.
            setContextMenu({ xPx: e.clientX, yPx: e.clientY });
          }}
        >
          {page.sources && page.sources.length > 0 && (
            <CitationsChip sources={page.sources} />
          )}
          {page.nodeId && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void togglePinStyle();
              }}
              disabled={styleAnchorPending}
              aria-pressed={styleAnchor?.nodeId === page.nodeId}
              title={
                styleAnchor?.nodeId === page.nodeId
                  ? "Style locked to this page — click to unlock"
                  : styleAnchor
                    ? "Pin this page's style for the rest of the session"
                    : "Pin this page as the session's visual style"
              }
              className={
                "pointer-events-auto absolute bottom-3 start-3 z-10 flex select-none items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium backdrop-blur transition " +
                (styleAnchor?.nodeId === page.nodeId
                  ? "border-amber-400/70 bg-amber-100/80 text-amber-900 hover:bg-amber-100"
                  : "border-[var(--color-ink)]/30 bg-[var(--color-paper)]/80 text-[var(--color-ink)] hover:bg-[var(--color-paper)]") +
                (styleAnchorPending ? " opacity-60" : "")
              }
            >
              <span aria-hidden>📌</span>
              <span>
                {styleAnchorPending
                  ? "Pinning…"
                  : styleAnchor?.nodeId === page.nodeId
                    ? "Style locked"
                    : "Pin style"}
              </span>
            </button>
          )}
          <div className="relative aspect-[16/9] w-full">
            <div className="relative h-full w-full">
              {fallbackVideoUrl && showVideo ? (
                <video
                  src={fallbackVideoUrl}
                  className="block h-full w-full object-contain"
                  autoPlay
                  loop
                  muted
                  playsInline
                  controls
                />
              ) : process.env.NEXT_PUBLIC_LTX_WS_URL &&
                streamStatus !== "off" &&
                streamStatus !== "error" ? (
                <video
                  ref={videoRef}
                  className="block h-full w-full object-contain"
                  autoPlay
                  muted
                  playsInline
                  controls
                />
              ) : (
                <MorphImagePair
                  imgRef={imgRef}
                  imageDataUrl={page.imageDataUrl}
                  alt={`Generated illustration for ${page.query}`}
                  morphFx={morphFx}
                  onError={() => setImgFailed(true)}
                  newImageClassName={
                    "absolute inset-0 block h-full w-full object-contain select-none " +
                    (morphFx ? "ec-morph-new " : "") +
                    (progressiveDraft && phase === "generating" ? "ec-draft " : "") +
                    (streamStatus === "connecting"
                      ? "cursor-wait"
                      : phase === "generating" || editMode
                        ? "cursor-crosshair"
                        : "cursor-none")
                  }
                  onMorphTransitionEnd={(e) => {
                    // Ink-bloom transitions on `mask-size` / `-webkit-mask-size`;
                    // the reduced-motion path falls back to opacity. Accept all
                    // three so transition-end fires on every supported path.
                    if (
                      e.propertyName !== "mask-size" &&
                      e.propertyName !== "-webkit-mask-size" &&
                      e.propertyName !== "opacity"
                    ) {
                      return;
                    }
                    setMorphFx((prev) => {
                      if (!prev || prev.phase !== "reveal") return prev;
                      hudEmit("morph:end", { duration_ms: nowMs() - prev.startedAt });
                      return null;
                    });
                  }}
                />
              )}
              {strokeState && <StrokeOverlay pxPoints={strokeState.pxPoints} />}

              {imgFailed && <ImageFailedOverlay />}

              {hoverPos &&
                phase !== "generating" &&
                !editMode &&
                streamStatus === "off" && (
                  <HoverCrosshair xPx={hoverPos.xPx} yPx={hoverPos.yPx} />
                )}

              {clickRipple && phase === "generating" && (
                <ClickRipple
                  rippleKey={clickRipple.key}
                  xPx={clickRipple.xPx}
                  yPx={clickRipple.yPx}
                />
              )}

              {hintPrompt && (
                <HintPrompt
                  xPx={hintPrompt.xPx}
                  yPx={hintPrompt.yPx}
                  placeholder={hintPrompt.question ?? ""}
                  onSubmit={(text) => {
                    hintPrompt.resolve(text);
                    setHintPrompt(null);
                  }}
                  onCancel={() => {
                    hintPrompt.resolve(null);
                    setHintPrompt(null);
                  }}
                />
              )}
              {clickDetail && (
                <ClickDetailPopover
                  xPx={clickDetail.xPx}
                  yPx={clickDetail.yPx}
                  entities={clickDetail.entities}
                  crop={clickDetail.crop}
                  initial={clickDetail.initial}
                  onConfirm={(r) => {
                    clickDetail.resolve(r);
                    setClickDetail(null);
                  }}
                  onCancel={() => {
                    clickDetail.resolve(null);
                    setClickDetail(null);
                  }}
                />
              )}
              <EntityHoverOverlay
                nodeId={page?.nodeId ?? null}
                entities={worldState.entities}
                enabled={
                  entityChipsEnabled &&
                  phase !== "generating" &&
                  streamStatus === "off"
                }
                onSelect={() => setCodexOpen(true)}
                imgRef={imgRef}
              />
              {geoOverlayOn && page?.nodeId && (
                <GeometryOverlay
                  nodeId={page.nodeId}
                  entities={worldState.entities}
                  imgRef={imgRef}
                />
              )}
              {geoOverlayOn && (
                <WorldMiniMap
                  sessionId={sessionId}
                  focusId={
                    page?.sceneView && page.sceneView.level !== "map"
                      ? page.sceneView.focus_id ?? null
                      : null
                  }
                  crop={
                    page?.sceneView?.level === "map"
                      ? page.sceneView.map_crop ?? null
                      : null
                  }
                />
              )}
            </div>

            {page?.nodeId &&
              !beaconsHidden &&
              (streamStatus === "off" || streamStatus === "error") && (
                <BranchBeacons
                  beacons={history.items
                    .filter(
                      (
                        p,
                      ): p is Page & {
                        nodeId: string;
                        clickInParent: { xPct: number; yPct: number };
                      } =>
                        Boolean(p.nodeId && p.parentId === page.nodeId && p.clickInParent),
                    )
                    .map((p) => ({
                      nodeId: p.nodeId,
                      title: p.title,
                      clickInParent: p.clickInParent,
                    }))}
                  onSelect={selectFromMap}
                />
              )}

            {phase === "generating" && <GeneratingBanner statusMsg={statusMsg} />}

            {phase !== "generating" &&
              streamStatus === "connecting" &&
              !fallbackVideoUrl && (
                <div className="pointer-events-none absolute inset-0 flex items-end bg-black/20">
                  <div className="m-4 flex items-center gap-3 rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg">
                    <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-white/90" />
                    <span>
                      Animating image… this can take 30-90s. The image stays
                      visible until the clip is ready.
                    </span>
                  </div>
                </div>
              )}

            <div className="absolute right-3 top-3 flex gap-2">
              <button
                type="button"
                onClick={triggerExpand}
                disabled={
                  phase === "generating" ||
                  !page?.imageDataUrl ||
                  (bloom !== null && !bloom.done)
                }
                className="flex items-center gap-1.5 rounded-full bg-teal-600/85 px-3 py-1 text-xs text-white hover:bg-teal-600 disabled:opacity-50"
                title="Look around (E) — bloom the world around this page (vs tap a region to go in)"
              >
                <BloomGlyph className="h-3.5 w-3.5" />
                Around
              </button>
              <button
                type="button"
                onClick={() => setGeoOverlayOn((v) => !v)}
                aria-pressed={geoOverlayOn}
                disabled={!page?.nodeId}
                className={
                  "rounded-full px-3 py-1 text-xs text-white disabled:opacity-50 " +
                  (geoOverlayOn ? "bg-emerald-600" : "bg-slate-600/85 hover:bg-slate-600")
                }
                title="Geometry layer — draw each entity's detected coordinate box on the image"
              >
                ⊞ geo
              </button>
              <button
                type="button"
                onClick={() => setCodexOpen((c) => !c)}
                aria-pressed={codexOpen}
                className={
                  "rounded-full px-3 py-1 text-xs text-white " +
                  (codexOpen
                    ? "bg-[var(--color-ink)]"
                    : "bg-black/60 hover:bg-black/75")
                }
                title="Open the world codex (K). Lists every character, place, and item the explorer has seen."
              >
                Codex
                {worldState.entities.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-white/15 px-1.5 text-[10px] tabular-nums">
                    {worldState.entities.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditMode((v) => !v);
                  setEditInstruction("");
                }}
                disabled={phase === "generating"}
                aria-pressed={editMode}
                className={
                  "rounded-full px-3 py-1 text-xs text-white disabled:opacity-50 " +
                  (editMode ? "bg-amber-600" : "bg-black/60 hover:bg-black/75")
                }
                title="Edit this image with a text instruction"
              >
                {editMode ? t.cancelEdit : t.edit}
              </button>
              {!process.env.NEXT_PUBLIC_LTX_WS_URL && streamStatus === "off" && (
                <div
                  role="group"
                  aria-label="Video quality tier"
                  className="flex items-center overflow-hidden rounded-full border border-white/30 bg-black/60 text-[10px] text-white"
                  title="Video quality tier — fast (LTX), balanced (Wan 2.2), pro (LTX-2)"
                >
                  <span className="px-2 py-1 opacity-70">video</span>
                  {(["fast", "balanced", "pro"] as const).map((tier) => (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => setVideoTier(tier)}
                      aria-pressed={videoTier === tier}
                      className={
                        "px-2 py-1 transition-colors " +
                        (videoTier === tier
                          ? "bg-white text-black"
                          : "hover:bg-white/15")
                      }
                    >
                      {tier}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={
                  streamStatus === "off"
                    ? fallbackVideoUrl && !showVideo
                      ? replayVideo
                      : connectStream
                    : disconnectStream
                }
                className="rounded-full bg-black/60 px-3 py-1 text-xs text-white"
                title={
                  fallbackVideoUrl && !showVideo && streamStatus === "off"
                    ? "Replay the clip you already generated for this page (no new fal call)"
                    : process.env.NEXT_PUBLIC_LTX_WS_URL
                      ? "Stream an animated clip from Modal LTX"
                      : "Generate a 5-second clip via fal-ai/ltx-video (not streaming — full MP4)"
                }
              >
                {streamStatus === "off"
                  ? fallbackVideoUrl && !showVideo
                    ? "▶ Replay clip"
                    : process.env.NEXT_PUBLIC_LTX_WS_URL
                      ? t.animateStream
                      : t.animateClip
                  : streamStatus === "playing"
                    ? t.animateStop
                    : streamStatus === "connecting"
                      ? t.generatingClip
                      : `… ${streamStatus}`}
              </button>
            </div>
            {editMode ? (
              <EditForm
                instruction={editInstruction}
                setInstruction={setEditInstruction}
                onSubmit={submitEdit}
                busy={phase === "generating"}
                placeholder={t.editPlaceholder}
                applyLabel={t.apply}
              />
            ) : (
              <figcaption className="absolute bottom-0 left-0 right-0 bg-black/50 px-4 py-2 text-sm text-white">
                {t.tapHint}
              </figcaption>
            )}
          </div>
        </figure>
      ) : phase !== "generating" &&
        history.items.length === 0 &&
        styleAnchor === null &&
        !styleGalleryDismissed ? (
        <StyleGallery
          onPick={(presetId) => {
            setFromPreset(presetId);
            dismissStyleGallery();
          }}
          onSkip={dismissStyleGallery}
        />
      ) : (
        <div className="flex h-[60dvh] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--color-ink)]/30 text-center opacity-70">
          {phase === "generating" ? (
            <p>{statusMsg ?? "Generating first page..."}</p>
          ) : (
            <>
              <p>Type something above to begin.</p>
              <p className="text-sm">
                Or{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  upload an image
                </button>{" "}
                or drag one anywhere on this page.
              </p>
            </>
          )}
        </div>
      )}

      {page?.nodeId && (
        <p className="text-center text-xs opacity-60">
          Permalink: <code>/n/{page.nodeId}</code>
        </p>
      )}

      {quickbarOpen && (
        <Quickbar
          query={quickbarQuery}
          setQuery={setQuickbarQuery}
          items={history.items}
          onPick={(id) => {
            setQuickbarOpen(false);
            setQuickbarQuery("");
            selectFromMap(id);
          }}
          onClose={() => {
            setQuickbarOpen(false);
            setQuickbarQuery("");
          }}
        />
      )}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      <CodexPanel
        open={codexOpen}
        onClose={() => setCodexOpen(false)}
        entities={worldState.entities}
        loading={worldState.loading}
        error={worldState.error}
        chipsEnabled={entityChipsEnabled}
        onToggleChips={() => setEntityChipsEnabled((v) => !v)}
        overrideEnabled={worldState.overrideEnabled}
        onMutate={mutateWorldEntity}
        geoEditSessionId={sessionId}
      />

      {/* Hide the coach while the Around tray is open — both are pinned to
          bottom-centre, so they'd overlap; mid-bloom the hint is noise anyway.
          It returns when the tray is closed. */}
      {phase === "ready" && !helpOpen && !bloom && (
        <FirstRunCoach onShowHelp={() => setHelpOpen(true)} />
      )}

      {scrubberOpen && page?.imageDataUrl && history.trail.length > 1 && (
        <TimeScrubber
          frames={history.trail
            .map((id) => history.items.find((p) => p.nodeId === id))
            .filter((p): p is Page => Boolean(p))
            .map((p) => ({
              nodeId: p.nodeId ?? "",
              imageDataUrl: p.imageDataUrl,
              title: p.title,
            }))}
          currentIdx={history.trailIdx}
          onJump={(idx) => {
            setHistory((prev) =>
              idx === prev.trailIdx ? prev : navigateToTrailIdx(prev, idx)
            );
          }}
          onClose={() => setScrubberOpen(false)}
        />
      )}

      {bloom && (
        <NeighbourTray
          items={bloom.items}
          total={bloom.total}
          done={bloom.done}
          onPick={(item) => {
            if (item.nodeId) window.location.href = `/n/${item.nodeId}`;
          }}
          onClose={closeBloom}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.xPx}
          y={contextMenu.yPx}
          beaconsHidden={beaconsHidden}
          canCopy={!!page?.nodeId}
          canPrune={
            !!page?.nodeId &&
            history.items.some((p) => p.nodeId === page?.nodeId)
          }
          canSavePostcard={!!page?.nodeId}
          onCopyPermalink={() => {
            if (page?.nodeId) {
              const link = `${window.location.origin}/n/${page.nodeId}`;
              void navigator.clipboard?.writeText(link);
            }
            setContextMenu(null);
          }}
          onSavePostcard={() => {
            if (page?.nodeId) {
              window.open(`/api/postcard/${page.nodeId}?download=1`, "_blank");
            }
            setContextMenu(null);
          }}
          onPrune={() => {
            setContextMenu(null);
            if (!page?.nodeId) return;
            const targetId = page.nodeId;
            setHistory((prev) => {
              const subtree = new Set<string>();
              const queue = [targetId];
              while (queue.length) {
                const id = queue.shift()!;
                if (subtree.has(id)) continue;
                subtree.add(id);
                for (const item of prev.items) {
                  if (item.parentId === id && item.nodeId)
                    queue.push(item.nodeId);
                }
              }
              const removeCount = subtree.size;
              if (
                removeCount > 1 &&
                !window.confirm(
                  `Remove this branch and ${removeCount - 1} child page(s) from history? Persisted pages stay on disk.`
                )
              ) {
                return prev;
              }
              const items = prev.items.filter(
                (p) => !p.nodeId || !subtree.has(p.nodeId)
              );
              const trail = prev.trail.filter((id) => !subtree.has(id));
              return {
                items,
                trail,
                trailIdx: trail.length - 1,
              };
            });
          }}
          onToggleBeacons={() => {
            setBeaconsHidden((h) => !h);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      <DebugHud />

      {viewMode !== "map" && history.items.length >= 2 && (
        <SessionMinimap
          pages={history.items
            .filter((p): p is Page & { nodeId: string } => Boolean(p.nodeId))
            .map((p) => ({
              nodeId: p.nodeId,
              parentId: p.parentId ?? null,
              imageDataUrl: p.imageDataUrl,
              title: p.title,
              ...(p.clickInParent ? { clickInParent: p.clickInParent } : {}),
            }))}
          activeNodeId={page?.nodeId ?? null}
          onExpand={() => setViewMode("map")}
          onJump={selectFromMap}
        />
      )}
    </main>
  );
}
