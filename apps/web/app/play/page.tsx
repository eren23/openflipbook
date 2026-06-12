"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, DragEvent, FormEvent } from "react";
import type {
  Citation,
  EntityEditPlan,
  GenerateRequestBody,
  GenerateEvent,
  MapCrop,
  ObserverPose,
  ScaleTier,
  SceneView,
  ViewLevel,
  WorldEntityGeo,
} from "@openflipbook/config";
import {
  annotateClickPoint,
  annotateStroke,
  normalizeClickOnImage,
  objectContainRect,
  summarizeStroke,
  type NormalizedClick,
} from "@/lib/image-click";
import { entityAtPoint, padBox, type EntityHit } from "@/lib/entity-hit";
import { applyPlanInstruction } from "@/lib/geo-to-edit";
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
import { useLoopKnobs, wireFields } from "@/hooks/useSpeedPreset";
import { useSharedSession } from "@/hooks/useSharedSession";
import { useExpandBloom } from "@/hooks/useExpandBloom";
import { type Ascended, useAscend } from "@/hooks/useAscend";
import { buildConditionRefs, cropBox, orderedRefs } from "@/lib/image-condition";
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
import { EnterableMarkers } from "@/components/PlayPage/EnterableMarkers";
import { MapLabelOverlay } from "@/components/PlayPage/MapLabelOverlay";
import { ContextMenu, type ContextMenuItem } from "@/components/PlayPage/ContextMenu";
import { HoverCrosshair } from "@/components/PlayPage/HoverCrosshair";
import { HintPrompt } from "@/components/PlayPage/HintPrompt";
import { EditForm } from "@/components/PlayPage/EditForm";
import { RegionSelectOverlay } from "@/components/PlayPage/RegionSelectOverlay";
import {
  buildMaskPng,
  dragToRegion,
  regionToDisplayRect,
  type EditRegionBox,
} from "@/lib/edit-mask";
import { useContainRect } from "@/hooks/useContainRect";
import { formatEditVerdict } from "@/lib/edit-verdict";
import { ImageFailedOverlay } from "@/components/PlayPage/ImageFailedOverlay";
import { DragDropOverlay } from "@/components/PlayPage/DragDropOverlay";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useWorldState } from "@/hooks/useWorldState";
import { useWorldMap } from "@/hooks/useWorldMap";
import {
  degradedSubmapTap,
  geoTapForEntity,
  geoTapRequest,
  MAP_IMAGE_FRAME,
  regionBoxFor,
  wideRegionCut,
  type GeoTap,
  type GeoTapOverride,
} from "@/lib/geo-tap";
import { matchEntityLabel } from "@/lib/entity-label-match";
import { focusOnMap } from "@/lib/click-route";
import { selectNeighbors } from "@/lib/scale-neighbors";
import { sceneCloseupSpec } from "@/lib/scene-closeup";
import { childrenOf, projectTopDown } from "@/lib/world-geometry";
import { viewNeutralAppearance } from "@/lib/appearance";
import { useImageMorph } from "@/hooks/useImageMorph";
import {
  PREFETCH_LRU_MAX,
  PREFETCH_PER_PAGE,
  usePrefetchCache,
} from "@/hooks/usePrefetchCache";

type Phase = "idle" | "generating" | "ready" | "error";

// Select-area mask edits (E1). Build-time gate so the UI never offers a drag
// whose mask a flag-off backend would silently ignore (a whole-image edit
// after the user drew a box is the worst surprise). Backend twin: EDIT_REGION.
const EDIT_REGION_ENABLED = ["1", "true", "yes"].includes(
  (process.env.NEXT_PUBLIC_EDIT_REGION ?? "").toLowerCase()
);

// W1 kill-switch (default ON): a world-mode tap that the geometric router
// can't anchor (lettering / unmapped parchment) degrades to a faithful
// place_submap zoom-cut instead of falling to the fresh path, which ignores
// image refs and invents an unrelated scene. =false restores the old fall-
// through exactly (same semantics as ENTER_EDIT_REF's kill-switch).
const WORLD_TAP_DEGRADE_ENABLED = !["0", "false", "no"].includes(
  (process.env.NEXT_PUBLIC_WORLD_TAP_DEGRADE ?? "").toLowerCase()
);

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
  relation?: "descend" | "expand" | "edit";
  scale?: "component" | "peer" | "container";
  scale_tier?: ScaleTier;
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
async function triggerExtraction(args: {
  sessionId: string;
  nodeId: string;
  imageDataUrl: string;
  caption: string;
  sceneDescription?: string | null;
  // The view this node renders (geo-tap intent). When it carries a focus_id, the
  // extract route seeds this scene's sub-entities into that place's child frame.
  sceneView?: SceneView | null;
  traceId: string | null;
}): Promise<{ added: number; updated: number } | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (args.traceId) headers[TRACE_HEADER] = args.traceId;
  const attempt = async (): Promise<{ added: number; updated: number } | null> => {
    const t0 = nowMs();
    try {
      const res = await fetch(
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
      );
      if (!res.ok) {
        hudEmit("world:extract_error", {
          status: res.status,
          trace_id: args.traceId,
          t: nowMs(),
        });
        return null;
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
      return {
        added: payload.added_ids?.length ?? 0,
        updated: payload.updated_ids?.length ?? 0,
      };
    } catch {
      // Best-effort. The codex view will refetch on its own if a user
      // opens it; nothing to roll back here.
      return null;
    }
  };
  const first = await attempt();
  // The first extraction after a generation occasionally stores NOTHING
  // (the ladder-proof harness hit it on 3 of 12 runs) and a map with zero
  // entities dead-ends every tap until the user finds "localize now". A
  // 0/0 merge on a freshly rendered page is near-certain flake — re-fire
  // once; the route's diff-merge makes the second pass idempotent.
  if (first && first.added === 0 && first.updated === 0) {
    await new Promise((r) => setTimeout(r, 4000));
    return attempt();
  }
  return first;
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
  // Right-click target resolution (E2): the menu is geo-aware — `hit` is the
  // codex entity under the cursor (per-node bbox containment), `clickPct` the
  // normalized image point (null when the click landed outside the content,
  // e.g. on the letterbox). Both null → just the page-level menu items.
  const [contextMenu, setContextMenu] = useState<{
    xPx: number;
    yPx: number;
    clickPct: NormalizedClick | null;
    hit: EntityHit | null;
  } | null>(null);
  // Seeds the codex's geo editor ("move/resize this…" routes there).
  const [geoEditPrefill, setGeoEditPrefill] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  // Manual/auto re-extraction for a box-less page (the geo overlay's
  // "localize now"). Keyed to the node so stale status never leaks across
  // navigation; the ref caps the AUTO attempt at one per node per mount.
  const [localizeStatus, setLocalizeStatus] = useState<{
    nodeId: string;
    status: "running" | "failed";
  } | null>(null);
  const localizeAttemptedRef = useRef<Set<string>>(new Set());
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
  // Re-run extraction for the CURRENT node (one VLM call, ~$0.01).
  // Extraction normally fires once, right after a node generates — if that
  // pass stores nothing (transient VLM emptiness), the page would stay
  // box-less forever. world:extracted then refreshes codex + geo map.
  const localizeCurrentNode = useCallback(async () => {
    const nodeId = page?.nodeId;
    const imageDataUrl = page?.imageDataUrl;
    if (!nodeId || !imageDataUrl) return;
    localizeAttemptedRef.current.add(nodeId);
    setLocalizeStatus({ nodeId, status: "running" });
    const result = await triggerExtraction({
      sessionId,
      nodeId,
      imageDataUrl,
      caption: page?.title || page?.query || "",
      sceneDescription: page?.query ?? null,
      sceneView: page?.sceneView ?? null,
      traceId: null,
    });
    if (result && result.added + result.updated > 0) {
      setLocalizeStatus(null);
    } else {
      setLocalizeStatus({ nodeId, status: "failed" });
    }
  }, [page, sessionId]);
  // Auto-localize ONCE per node: the overlay is on, the page settled, and
  // nothing is localized here — exactly the state that used to dead-end at
  // a static "no localized geometry" message.
  useEffect(() => {
    const nodeId = page?.nodeId;
    if (!geoOverlayOn || !nodeId || phase !== "ready") return;
    if (localizeAttemptedRef.current.has(nodeId)) return;
    const hasBoxes = worldState.entities.some(
      (e) => e.appearance_bboxes?.[nodeId],
    );
    if (hasBoxes) return;
    void localizeCurrentNode();
  }, [geoOverlayOn, page?.nodeId, phase, worldState.entities, localizeCurrentNode]);
  // Guard against re-entry between the click handler's synchronous
  // setMorphFx() call and React's next render that propagates
  // phase==="generating" into the click effect closure. Without this, a
  // double-click can pass the `phase === "generating"` check twice and start
  // two overlapping generates.
  const clickInFlightRef = useRef(false);
  const [hoverPos, setHoverPos] = useState<{
    xPx: number;
    yPx: number;
    enterable?: boolean;
  } | null>(
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
  const [loopKnobs, setLoopKnobs] = useLoopKnobs();
  // Running spend estimate for THIS session, read off final frames (the
  // backend meter, providers/spend.py). Null until the first final lands.
  const [sessionSpend, setSessionSpend] = useState<number | null>(null);
  // Dev-only explicit model override (NEXT_PUBLIC_DEV_PROVIDERS): rides the
  // wire's image_model on every generate body. null = the tier decides.
  const [devModel, setDevModel] = useState<string | null>(null);
  // Read-along shared sessions (Wave 8): live viewer count + a click-to-open
  // chip when a co-viewer adds a page this tab hasn't seen.
  const knownNodeIds = useMemo(
    () =>
      new Set(
        history.items
          .map((p) => p.nodeId)
          .filter((id): id is string => Boolean(id)),
      ),
    [history.items],
  );
  const shared = useSharedSession(sessionId, knownNodeIds);
  // The speed preset's wire half — spread into every generate() body next to
  // image_tier. Balanced knobs produce {} (byte-identity with today).
  const loopWire = useMemo(() => wireFields(loopKnobs), [loopKnobs]);
  const [videoTier, setVideoTier] = useVideoTier();
  const [outputLocale, setOutputLocale] = usePersistedLocale();
  const [theme, setTheme] = usePersistedTheme();
  const t = getStrings(outputLocale);

  const [editMode, setEditMode] = useState(false);
  const [editInstruction, setEditInstruction] = useState("");
  // Select-area edit (EDIT_REGION): the committed selection (normalized,
  // natural-image space), the live drag rect (element px), and the verdict
  // toast the judged edit's final frame reports. All scoped to editMode.
  const [editRegion, setEditRegion] = useState<EditRegionBox | null>(null);
  const [editDragRect, setEditDragRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const editDragStartRef = useRef<{ x: number; y: number } | null>(null);
  // The verdict chip (E3): persists while the edited page is current —
  // cleared by a new generation, navigation, or its own dismiss/revert.
  const [editVerdictChip, setEditVerdictChip] = useState<{
    text: string;
    revertTo: string | null;
  } | null>(null);
  const containRect = useContainRect(imgRef);
  const editRegionDisplayRect = useMemo(
    () =>
      editRegion && containRect
        ? regionToDisplayRect(editRegion, containRect)
        : null,
    [editRegion, containRect]
  );
  // Anchor the edit box just under the selection (clamped into the figure);
  // no selection -> undefined -> the form keeps its bottom-bar position.
  const editFormStyle = useMemo<CSSProperties | undefined>(() => {
    if (!editRegionDisplayRect || !containRect) return undefined;
    const boxW = containRect.offsetX * 2 + containRect.width;
    const boxH = containRect.offsetY * 2 + containRect.height;
    const width = Math.min(320, Math.max(240, editRegionDisplayRect.width));
    return {
      left: Math.max(
        4,
        Math.min(editRegionDisplayRect.left, boxW - width - 4)
      ),
      right: "auto",
      bottom: "auto",
      top: Math.min(
        editRegionDisplayRect.top + editRegionDisplayRect.height + 8,
        boxH - 44
      ),
      width,
      borderRadius: 9999,
    };
  }, [editRegionDisplayRect, containRect]);
  useEffect(() => {
    if (!editRegion) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditRegion(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editRegion]);

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
    domLabels: worldDomLabels,
    setEnabled: setWorldEnabled,
    setAutonomy: setWorldAutonomy,
    setDomLabels: setWorldDomLabels,
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
      setEditVerdictChip(null);
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
                // The pro model has no fast draft to show (OpenRouter path)
                // and routinely takes minutes — say so instead of leaving a
                // silent spinner (the 3-minute-riverflow mystery). Read the
                // tier off the REQUEST body: this callback is deliberately
                // dependency-free, so component state here would be stale.
                const proNote =
                  body.image_tier === "pro"
                    ? " (pro model — usually 2–3 min)"
                    : "";
                setStatusMsg(
                  evt.page_title
                    ? `Drawing "${evt.page_title}"…${proNote}`
                    : `Drawing image…${proNote}`
                );
              } else if (evt.stage === "draft") {
                setStatusMsg("Draft preview — the full render is refining…");
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
              if (typeof evt.session_spend_estimate === "number") {
                setSessionSpend(evt.session_spend_estimate);
              }
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
              // Judged edit: surface what the critics saw, with a one-click
              // path back to the pre-edit node (undo, made felt).
              if (evt.edit_verdict) {
                setEditVerdictChip({
                  text: formatEditVerdict(evt.edit_verdict),
                  revertTo:
                    body.mode === "edit" ? body.current_node_id || null : null,
                });
              }
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
                  // An edit is a REVISION of the current page, not a place
                  // inside it — the graph chrome renders it as "✎ edited".
                  ...(body.mode === "edit" ? { relation: "edit" as const } : {}),
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
                  void triggerExtraction({
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
    // Persistent style exemplar: the pinned style page's image if one is
    // pinned, else the root render. Rides as the "style" role (strong medium
    // lock in the backend preamble) so the bloom can't drift the art medium.
    const styleRefUrl =
      (styleAnchor
        ? history.items.find((p) => p.nodeId === styleAnchor.nodeId)
            ?.imageDataUrl
        : null) ??
      history.items.find((p) => p.parentId == null)?.imageDataUrl ??
      null;
    const condition = orderedRefs({
      parent: page.imageDataUrl,
      style: styleRefUrl !== page.imageDataUrl ? styleRefUrl : null,
    });
    // Logical AROUND (SCALE_AROUND_LOGICAL, server-gated): when you're INSIDE a
    // place, ground the bloom in the same-scale neighbours the geometry already
    // knows — pass them as exclusions + the focus's rung so the bloom proposes NEW
    // peers at that scale. No focus (top-level map) → today's unconstrained bloom.
    const focusId = page.sceneView?.focus_id ?? null;
    const around =
      worldEnabled && focusId
        ? selectNeighbors(focusId, geoMap.entities, page.sceneView?.scale_tier ?? null)
        : null;
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
      ...loopWire,
      ...(devModel ? { image_model: devModel } : {}),
      output_locale: resolveOutputLocale(outputLocale),
      ...(condition.urls.length
        ? {
            condition_image_urls: condition.urls,
            condition_roles: condition.roles,
          }
        : {}),
      ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
      ...(around?.tier
        ? { known_neighbors: around.known, around_tier: around.tier }
        : {}),
    });
  }, [
    page,
    phase,
    bloom,
    startBloom,
    imageTier,
    loopWire,
    devModel,
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
            void triggerExtraction({
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
        ...loopWire,
        ...(devModel ? { image_model: devModel } : {}),
        output_locale: resolveOutputLocale(outputLocale),
        ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
        // DOM-labels mode: the root map renders text-free; names overlay.
        ...(worldEnabled && worldDomLabels ? { suppress_map_labels: true } : {}),
      });
    },
    [input, sessionId, page, generate, imageTier, loopWire, devModel, outputLocale, styleAnchor, worldEnabled, worldDomLabels]
  );

  // B1 — "Describe a place": turn the input description into a logical object
  // world. POST /plan-world (parse -> deterministic solver, server-side); if it's
  // BLOCKED (contradiction / over-pack / reserved-region collision) loop the
  // clarifiers through the SAME hint bubble taps use, re-POST with the answers;
  // on a non-null `solved`, seed the geos (the logical plane the map taps route
  // through) and render a top-down plan from the description + planned visuals.
  // Gated behind World Mode; the backend gates WORLD_FROM_DESCRIPTION (403 off).
  const planWorld = useCallback(async () => {
    const description = input.trim();
    if (!description || phase === "generating") return;
    type PW = {
      graph?: {
        place_label?: string;
        entities?: { visual?: string }[];
        empty_regions?: { note?: string }[];
        clarifiers?: string[];
        contradictions?: string[];
      };
      solved?: WorldEntityGeo[] | null;
      error?: string;
    };
    const cx = typeof window !== "undefined" ? window.innerWidth / 2 : 400;
    const cy = typeof window !== "undefined" ? window.innerHeight / 2 : 280;
    let answers: string[] = [];
    let graph: PW["graph"] = undefined;
    let solved: WorldEntityGeo[] | null = null;
    try {
      for (let round = 0; round < 4; round += 1) {
        const res = await fetch(
          `/api/world/${encodeURIComponent(sessionId)}/plan-world`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId, description, answers }),
          },
        );
        const data = (await res.json().catch(() => ({}))) as PW;
        if (!res.ok) {
          setError(data.error ?? "describe-a-place is off (set WORLD_FROM_DESCRIPTION)");
          return;
        }
        graph = data.graph;
        solved = data.solved ?? null;
        if (solved) break;
        const questions = graph?.clarifiers ?? [];
        if (questions.length === 0) {
          setError(
            `That place doesn't quite work: ${(graph?.contradictions ?? []).join("; ") || "unresolved"}`,
          );
          return;
        }
        const answer = await promptForHint(cx, cy, questions.join("  ·  "));
        if (answer == null) return; // cancelled
        answers = [...answers, answer];
      }
      if (!solved || !graph) {
        setError("Couldn't resolve the place after a few rounds — try rephrasing.");
        return;
      }
      // Seed the logical plane (best-effort; needs GEOMETRIC_WORLD on the server).
      await fetch(`/api/world/${encodeURIComponent(sessionId)}/map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geos: solved }),
      }).catch(() => {});
      // Render a top-down plan from the description + the planned visuals. The
      // empty-region notes ride in the query text (the doc-sanctioned render-layer
      // enforcement of "empty stays empty", alongside the grounding extras penalty).
      const visuals = (graph.entities ?? [])
        .map((e) => e.visual)
        .filter((v): v is string => !!v && v.trim().length > 0)
        .slice(0, 12)
        .join("; ");
      const empties = (graph.empty_regions ?? [])
        .map((r) => r.note)
        .filter((n): n is string => !!n && n.trim().length > 0);
      const emptyClause = empties.length
        ? ` Leave these areas clear and empty: ${empties.join(", ")}.`
        : "";
      const query =
        `A top-down illustrated map of ${graph.place_label ?? "the place"}. ${description}.` +
        (visuals ? ` Showing: ${visuals}.` : "") +
        emptyClause;
      void generate({
        query,
        aspect_ratio: "16:9",
        web_search: false,
        session_id: sessionId,
        current_node_id: page?.nodeId ?? "",
        mode: "query",
        image_tier: imageTier,
        ...loopWire,
        ...(devModel ? { image_model: devModel } : {}),
        output_locale: resolveOutputLocale(outputLocale),
        world_mode: true,
        render_mode: "place_submap",
        // Steer the render with the solved layout (top-down). Inert unless the
        // backend WORLD_GEOMETRY_GEN flag is on; +0.33 layout fidelity in the A/B.
        expected_layout: projectTopDown(solved, MAP_IMAGE_FRAME),
        scene_view: {
          node_id: page?.nodeId ?? "",
          level: "map",
          observer: null,
          map_crop: MAP_IMAGE_FRAME,
          // The root map's camera is DELIBERATE: flat 2D top-down, stated in
          // the prompt every render (the view grammar's locked default) —
          // never the accidental half-2.5D drift again.
          view: {
            projection: "top_down",
            pitch_deg: -90,
            camera_height: "aerial",
            azimuth_deg: 0,
            source: "policy",
          },
        },
        ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
      });
    } catch (err) {
      setError(`describe-a-place failed: ${(err as Error).message}`);
    }
  }, [
    input,
    phase,
    sessionId,
    page,
    generate,
    imageTier,
    loopWire,
    devModel,
    outputLocale,
    styleAnchor,
    promptForHint,
  ]);

  // The edit primitive: the EditForm submits through it, and the context
  // menu's one-click actions (fix/redraw, remove) call it directly with a
  // canned instruction + the target's padded bbox.
  const runEdit = useCallback(
    async (instruction: string, region: EditRegionBox | null) => {
      if (!instruction || !page?.imageDataUrl) return;
      // Select-area edit: a committed selection rides along as a white=edit
      // mask PNG at natural dims + the region box (judge crop scope). Mask
      // build failure falls back to today's whole-image edit.
      let maskFields: Partial<GenerateRequestBody> = {};
      const imgEl = imgRef.current;
      if (EDIT_REGION_ENABLED && region && imgEl?.naturalWidth) {
        try {
          maskFields = {
            edit_mask: await buildMaskPng(
              imgEl.naturalWidth,
              imgEl.naturalHeight,
              region
            ),
            edit_region: region,
          };
        } catch {
          /* whole-image fallback */
        }
      }
      // Carry the style exemplar (pinned page, else root) so an edit can't drift
      // the art medium. The backend edit path now threads both this "style" ref
      // and the session text lock.
      const styleRefUrl =
        (styleAnchor
          ? history.items.find((p) => p.nodeId === styleAnchor.nodeId)
              ?.imageDataUrl
          : null) ??
        history.items.find((p) => p.parentId == null)?.imageDataUrl ??
        null;
      const editCondition = orderedRefs({
        style: styleRefUrl !== page.imageDataUrl ? styleRefUrl : null,
      });
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
        ...loopWire,
        ...(devModel ? { image_model: devModel } : {}),
        output_locale: resolveOutputLocale(outputLocale),
        ...(editCondition.urls.length
          ? {
              condition_image_urls: editCondition.urls,
              condition_roles: editCondition.roles,
            }
          : {}),
        ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
        ...maskFields,
      });
      setEditInstruction("");
      setEditMode(false);
      setEditRegion(null);
    },
    [page, generate, imageTier, loopWire, devModel, outputLocale, styleAnchor, history]
  );

  const submitEdit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      await runEdit(editInstruction.trim(), editRegion);
    },
    [runEdit, editInstruction, editRegion]
  );

  // E4 apply-to-image: a just-landed geo plan becomes ONE page edit in the
  // repair register ("keep everything else exactly as it is — only adjust:
  // move the lighthouse north"). Coordinates moved; the pixels follow —
  // judged by the edit loop when its flags are on.
  const geoApplyToImage = useCallback(
    (plan: EntityEditPlan, entitiesAtApply: WorldEntityGeo[]) => {
      const frame =
        geoMap.bounds.w > 0 && geoMap.bounds.h > 0
          ? { w: geoMap.bounds.w, h: geoMap.bounds.h }
          : { w: 100, h: 60 };
      const instruction = applyPlanInstruction(plan.edits, entitiesAtApply, frame);
      if (!instruction) return;
      setCodexOpen(false);
      void runEdit(instruction, null);
    },
    [geoMap.bounds, runEdit]
  );

  // The context menu's "Enter {entity}": a synthetic click on the image at
  // the entity's bbox centre, so the EXISTING tap flow runs verbatim —
  // revisit check, world-mode routing, condition refs, morph — instead of a
  // drifting re-implementation.
  const dispatchTapAt = useCallback((xPct: number, yPct: number) => {
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const content = objectContainRect(
      rect.width,
      rect.height,
      img.naturalWidth,
      img.naturalHeight
    );
    if (!content) return;
    img.dispatchEvent(
      new MouseEvent("click", {
        clientX: rect.left + content.offsetX + xPct * content.width,
        clientY: rect.top + content.offsetY + yPct * content.height,
        bubbles: true,
        cancelable: true,
      })
    );
  }, []);

  // The geo-aware section of the right-click menu (E2): target-aware actions
  // routed to the primitives that already exist — runEdit (E1 mask path),
  // the tap flow, the codex's NL geometry editor. Pure derivation from the
  // resolved target; the ContextMenu component stays dumb.
  const contextExtraItems = useMemo<ContextMenuItem[]>(() => {
    if (!contextMenu || phase === "generating") return [];
    const items: ContextMenuItem[] = [];
    const close = () => setContextMenu(null);
    if (contextMenu.hit) {
      const { entity, bbox } = contextMenu.hit;
      items.push({
        label: `Enter ${entity.name}`,
        onClick: () => {
          close();
          dispatchTapAt(bbox.x_pct + bbox.w_pct / 2, bbox.y_pct + bbox.h_pct / 2);
        },
      });
      if (EDIT_REGION_ENABLED) {
        items.push({
          label: `Fix / redraw ${entity.name}`,
          onClick: () => {
            close();
            void runEdit(
              `redraw the ${entity.name} cleanly, repairing any glitches or artifacts`,
              padBox(bbox)
            );
          },
        });
        items.push({
          label: `Remove ${entity.name}`,
          danger: true,
          onClick: () => {
            close();
            void runEdit(`remove the ${entity.name}`, padBox(bbox));
            // E4: the pixels go AND the world model follows — soft delete
            // with the codex's existing 10s undo; the edited page's
            // re-extraction won't re-add what's no longer drawn.
            void mutateWorldEntity({ op: "delete", id: entity.id });
          },
        });
      }
      if (geoMap.entities.length > 0 && worldState.overrideEnabled) {
        items.push({
          label: `Move / resize ${entity.name}…`,
          onClick: () => {
            close();
            setGeoEditPrefill({ text: `move the ${entity.name} `, nonce: Date.now() });
            setCodexOpen(true);
          },
        });
      }
    } else if (contextMenu.clickPct && EDIT_REGION_ENABLED) {
      // Fill paints the whole mask, so the default region IS the default
      // object size — keep it modest (the palace-sized ferry lesson).
      const region = cropBox(
        contextMenu.clickPct.x_pct,
        contextMenu.clickPct.y_pct,
        0.18
      );
      items.push({
        label: "Add something here…",
        onClick: () => {
          close();
          setEditMode(true);
          setEditRegion(region);
          setEditInstruction("add ");
        },
      });
      items.push({
        label: "Edit this area",
        onClick: () => {
          close();
          setEditMode(true);
          setEditRegion(region);
          setEditInstruction("");
        },
      });
    }
    // Export the root→here path as a shareable artifact (Wave 6). Server
    // route walks the chain; these just open the download.
    if (page?.nodeId) {
      const exportId = page.nodeId;
      for (const fmt of ["pdf", "zip", "gif"] as const) {
        items.push({
          label: `Export path (${fmt.toUpperCase()})`,
          onClick: () => {
            close();
            window.open(`/api/export/${exportId}?fmt=${fmt}`, "_blank");
          },
        });
      }
      // Opt-in gallery (Wave 7): this page fronts the published session.
      const publishSessionId = page.sessionId;
      items.push({
        label: "Publish session to gallery",
        onClick: () => {
          close();
          void fetch("/api/gallery/publish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: publishSessionId,
              node_id: exportId,
            }),
          }).then(async (r) => {
            if (r.ok) {
              window.open("/gallery", "_blank");
            } else {
              const j = (await r.json().catch(() => null)) as {
                error?: string;
              } | null;
              window.alert(j?.error ?? "publish failed");
            }
          });
        },
      });
      items.push({
        label: "Unpublish session",
        onClick: () => {
          close();
          void fetch(
            `/api/gallery/publish?session_id=${encodeURIComponent(publishSessionId)}`,
            { method: "DELETE" },
          );
        },
      });
    }
    return items;
  }, [contextMenu, phase, page, dispatchTapAt, runEdit, geoMap.entities.length, mutateWorldEntity]);

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
    setEditVerdictChip(null);
    setHistory((prev) =>
      prev.trailIdx <= 0 ? prev : navigateToTrailIdx(prev, prev.trailIdx - 1)
    );
  }, []);

  const goForward = useCallback(() => {
    setEditVerdictChip(null);
    setHistory((prev) =>
      prev.trailIdx >= prev.trail.length - 1
        ? prev
        : navigateToTrailIdx(prev, prev.trailIdx + 1)
    );
  }, []);

  const selectFromMap = useCallback((nodeId: string) => {
    setEditVerdictChip(null);
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

  // OUTWARD / zoom-out landed: mirror the persisted reparent into the live
  // session — insert the container P, re-point the old root C under it (so the
  // breadcrumb shows P above C), navigate to P, and refetch the geo store.
  const onAscended = useCallback(
    (a: Ascended) => {
      const parentPage: Page = {
        nodeId: a.parentNodeId,
        sessionId,
        query: a.pageTitle,
        title: a.pageTitle,
        imageDataUrl: a.imageDataUrl,
        parentId: null,
        sceneView: a.sceneView,
      };
      setHistory((prev) => {
        const items = prev.items.map((p) =>
          p.nodeId === a.childNodeId ? { ...p, parentId: a.parentNodeId } : p,
        );
        const trail = [...prev.trail.slice(0, prev.trailIdx + 1), a.parentNodeId];
        return { items: [...items, parentPage], trail, trailIdx: trail.length - 1 };
      });
      setPage(parentPage);
      setPhase("ready");
      setViewMode("page");
      const url = new URL(window.location.href);
      url.pathname = `/n/${a.parentNodeId}`;
      window.history.replaceState({}, "", url.toString());
      void geoRefetch();
    },
    [sessionId, geoRefetch],
  );
  const { start: startAscend, pending: ascendPending, error: ascendError } =
    useAscend(onAscended);
  // OUTWARD is offered only from a ROOT page (a top-level map): it synthesizes the
  // container ABOVE it. Gated by worldEnabled (client) + SCALE_OUTWARD (server).
  const canAscend = Boolean(
    worldEnabled && page?.nodeId && page.imageDataUrl && !page.parentId && !ascendPending,
  );
  const handleAscend = useCallback(() => {
    if (!page?.nodeId || !page.imageDataUrl) return;
    startAscend(sessionId, {
      nodeId: page.nodeId,
      query: page.query,
      imageDataUrl: page.imageDataUrl,
      aspectRatio: "16:9",
      sceneView: page.sceneView ?? null,
    });
  }, [page, sessionId, startAscend]);

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
        // The world_map seeds a beat after a generation and this handler's geoMap
        // closure can lag it — so the FIRST ⌘-tap after a gen would see no
        // entities and silently fall to the hint. Fetch fresh when it's empty.
        let geoEntities = geoMap.entities;
        let geoBounds = geoMap.bounds;
        if (worldEnabled && geoEntities.length === 0) {
          const fresh = (await fetch(
            `/api/world/${encodeURIComponent(sessionId)}/map`,
          )
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)) as
            | { entities: WorldEntityGeo[]; bounds: MapCrop }
            | null;
          if (fresh?.entities?.length) {
            geoEntities = fresh.entities;
            geoBounds = fresh.bounds;
          }
        }
        const previewTap =
          worldEnabled && geoEntities.length > 0
            ? geoTapRequest(
                { entities: geoEntities, bounds: geoBounds },
                page.nodeId ?? "",
                click,
                16 / 9,
                undefined,
                // Preview in the CURRENT frame too (children of the place you're
                // inside), so the ⌘-popover nests deeper rather than re-routing
                // to a city landmark.
                page.sceneView,
              )
            : null;
        const previewObserver = previewTap?.scene_view.observer ?? null;
        if (previewTap && previewObserver) {
          // Frame the editor on the camera↔place axis (not the whole city).
          const focusEnt = geoEntities.find((e) => e.id === previewTap.focus_id);
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
          geoOverride = {
            observer: detail.observer,
            level: detail.level,
            // The projection pill (absent = auto: the backend policy decides).
            ...(detail.view ? { view: detail.view } : {}),
          };
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
      // The persistent style exemplar (pinned style page, else the root render)
      // rides as the strong "style" role so an enter can't drift the art medium.
      const styleRefUrl =
        (styleAnchor
          ? history.items.find((p) => p.nodeId === styleAnchor.nodeId)
              ?.imageDataUrl
          : null) ??
        history.items.find((p) => p.parentId == null)?.imageDataUrl ??
        null;
      // Close the geometric loop: a tap on the seeded world map → an observer
      // pose + the projected layout, so the entered scene is steered and
      // grounded by where the entities actually are. Only when World Mode is on
      // AND the geo world is seeded; null falls back to the existing World Mode
      // path. generate.py acts on these only under WORLD_GEOMETRY_GEN /
      // VLM_GROUNDING, so sending them is otherwise inert.
      // The world_map seeds a beat after a generation and this handler's geoMap
      // closure can lag it — so a tap right after a gen would see no entities,
      // produce a null geoTap, and persist the entered node with scene_view:null
      // (which breaks all downstream nesting). Fetch fresh when empty.
      let geoEntities = geoMap.entities;
      let geoBounds = geoMap.bounds;
      // World OFF also needs the geos now: wideRegionCut hit-tests them to
      // route river-style taps to the zoom-cut. Cheap, and only when empty.
      if (geoEntities.length === 0) {
        const fresh = (await fetch(
          `/api/world/${encodeURIComponent(sessionId)}/map`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)) as
          | { entities: WorldEntityGeo[]; bounds: MapCrop }
          | null;
        if (fresh?.entities?.length) {
          geoEntities = fresh.entities;
          geoBounds = fresh.bounds;
        }
      }
      const geoTap =
        worldEnabled && geoEntities.length > 0
          ? geoTapRequest(
              { entities: geoEntities, bounds: geoBounds },
              page.nodeId ?? "",
              { x_pct: click.x_pct, y_pct: click.y_pct },
              16 / 9,
              geoOverride,
              // Route in the CURRENT frame: on the city map this is the whole
              // map; INSIDE a place it's that place's children, so the tap nests
              // one level deeper instead of resolving to a city landmark.
              page.sceneView,
            )
          : null;
      // W1/W2 fallback chain: the geometric route fell through on a map frame
      // (the tap landed on baked-in lettering or unmapped parchment). Without
      // this, the request rides the classic FRESH path — which ignores image
      // refs — and that is the "brand-new unrelated city near the river" bug.
      //   ① label match: the VLM's subject names a mapped place (the tap hit
      //     the map's LETTERING) → enter that entity, footprint-hit semantics.
      //   ② degrade (kill-switch): zoom-continue the clicked region — a
      //     faithful Kontext cut of the map, never a reinvention.
      let fallbackTap: GeoTap | null = null;
      if (
        worldEnabled &&
        !geoTap &&
        geoEntities.length > 0 &&
        (!page.sceneView || page.sceneView.level === "map")
      ) {
        const matched = worldResolved?.subject
          ? matchEntityLabel(worldResolved.subject, geoEntities)
          : null;
        if (matched) {
          fallbackTap = geoTapForEntity(
            { entities: geoEntities, bounds: geoBounds },
            page.nodeId ?? "",
            matched,
            16 / 9,
            page.sceneView,
          );
        } else if (WORLD_TAP_DEGRADE_ENABLED) {
          fallbackTap = degradedSubmapTap(
            { entities: geoEntities, bounds: geoBounds },
            page.nodeId ?? "",
            { x_pct: click.x_pct, y_pct: click.y_pct },
            16 / 9,
            page.sceneView,
          );
        }
      }
      const worldTap = geoTap ?? fallbackTap;
      // Scene-level closeup (the ladder inside entered scenes): a tap on a
      // codex-localized entity zooms it before entering. The image-registered
      // bbox beats the bearing-recovered geometry, so this WINS over geoTap
      // when both resolve (spread last below).
      const sceneCloseup =
        worldEnabled && page.sceneView && page.sceneView.level !== "map"
          ? sceneCloseupSpec(
              worldState.entities,
              page.nodeId,
              { x_pct: click.x_pct, y_pct: click.y_pct },
              page.sceneView,
            )
          : null;
      // Conditioning refs are built AFTER routing so the region crop can BE
      // the routing window (closeup/submap: the reference IS the promise; a
      // transition tap from a closeup uses the whole frame-filling image as
      // the region — the enter starts tight and the step-in judge measures
      // tight). Classic taps keep the click-centered crop, byte-identical.
      let condition = { urls: [] as string[], roles: [] as string[] };
      try {
        const regionSpec = sceneCloseup
          ? sceneCloseup.kind === "closeup"
            ? { box: sceneCloseup.regionBox }
            : ({ whole: true } as const)
          : worldTap
            ? regionBoxFor(worldTap, page.sceneView ?? null)
            : null;
        condition = await buildConditionRefs({
          parentDataUrl: currentImage,
          styleDataUrl: styleRefUrl !== currentImage ? styleRefUrl : null,
          click: { xPct: click.x_pct, yPct: click.y_pct },
          ...(regionSpec && "box" in regionSpec
            ? { regionBox: regionSpec.box }
            : {}),
          ...(regionSpec && "whole" in regionSpec ? { regionWhole: true } : {}),
        });
      } catch {
        // leave condition empty → text-only generation
      }
      // World OFF + a wide mapped region (the river): a fresh re-composition
      // relocates landmarks, so zoom-cut the map instead (see wideRegionCut).
      const wideCut =
        !worldEnabled && geoEntities.length > 0
          ? wideRegionCut(
              { entities: geoEntities, bounds: geoBounds },
              page.nodeId ?? "",
              { x_pct: click.x_pct, y_pct: click.y_pct },
              16 / 9,
              page.sceneView,
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
        ...loopWire,
        ...(devModel ? { image_model: devModel } : {}),
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
              ...(worldDomLabels ? { suppress_map_labels: true } : {}),
              // The ladder's descent signal: entering from a closeup frame
              // goes to ground level (the closeup WAS the establishing shot).
              ...(page.sceneView?.closeup === true
                ? { from_closeup: true }
                : {}),
              ...(enterAsToRenderMode(worldResolved?.enter_as) !== "explainer"
                ? { render_mode: enterAsToRenderMode(worldResolved?.enter_as) }
                : {}),
            }
          : {}),
        ...(worldTap
          ? {
              scene_view: worldTap.scene_view,
              expected_layout: worldTap.expected_layout,
              // Enter the aligned-zoom path: a submap stays in map mode and
              // zoom-continues (Kontext) rather than a loose fresh gen, so the
              // sub-map is a true zoom of the tapped region. A scene first-enter
              // keeps the (reprojecting) fresh path until B2 wires the guarded
              // scene→scene continuation. Spread last so it wins.
              // closeup + submap both ride the Kontext zoom-continue (the
              // high-consistency op); only a true transition tap enters.
              render_mode:
                worldTap.kind === "scene" ? "place_scene" : "place_submap",
              // Magnified baked lettering always garbles ("The Great kee") —
              // closeups render text-free regardless of the labels pill; the
              // name lives in the page title / DOM labels.
              ...(worldTap.kind === "closeup"
                ? { suppress_map_labels: true }
                : {}),
              // The geometric tap KNOWS which entity you hit (by coordinates) —
              // make it the subject so tapping the Tower of Art enters the Tower,
              // overriding the looser VLM read that picked its container. Spread
              // last so it wins over the cached / world-resolved subjects above.
              ...(worldTap.focus_label
                ? { prefetched_subject: worldTap.focus_label }
                : {}),
              // Anchor the entity's IDENTITY across zoom levels: feed its
              // appearance as the authoritative subject context, view-neutral so
              // it carries the materials/architecture (ancient stone, concentric
              // rings) without forcing the angle it was captured at.
              ...(viewNeutralAppearance(worldTap.focus_visual)
                ? {
                    prefetched_subject_context: viewNeutralAppearance(
                      worldTap.focus_visual,
                    ),
                  }
                : {}),
              // FAITHFUL backdrop: the focus's frame-mates straight from the geo
              // (real bearings + appearances), so a stepped-into scene draws the
              // SAME landmarks the map shows in the right directions — overriding
              // the VLM-invented surroundings above (worldTap is spread last → wins).
              ...(worldTap.surroundings
                ? { prefetched_surroundings: worldTap.surroundings }
                : {}),
            }
          : {}),
        // Scene-level ladder (spread after worldTap so the image-registered
        // bbox closeup wins over the bearing-recovered geometry route).
        ...(sceneCloseup
          ? sceneCloseup.kind === "closeup"
            ? {
                render_mode: "place_closeup" as const,
                scene_view: {
                  ...sceneCloseup.sceneView,
                  node_id: page.nodeId ?? "",
                },
                expected_layout: [],
                prefetched_subject: sceneCloseup.name,
              }
            : {
                render_mode: "place_scene" as const,
                prefetched_subject: sceneCloseup.name,
              }
          : {}),
        // The world-off zoom-cut: same submap continuation a world-mode submap
        // tap rides (Kontext on the region crop), so the river page is a CUT of
        // the map, not a re-imagined city. Spread last so the subject wins.
        ...(wideCut
          ? {
              render_mode: "place_submap",
              prefetched_subject: wideCut.focus_label,
              ...(viewNeutralAppearance(wideCut.focus_visual)
                ? {
                    prefetched_subject_context: viewNeutralAppearance(
                      wideCut.focus_visual,
                    ),
                  }
                : {}),
              ...(wideCut.surroundings
                ? { prefetched_surroundings: wideCut.surroundings }
                : {}),
            }
          : {}),
        ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
      });
    };
    const move = (evt: PointerEvent) => {
      if (evt.pointerType === "touch") return;
      const rect = img.getBoundingClientRect();
      // Enter affordance (W3): the crosshair grows an "enter" ring over an
      // enterable place — world mode, map frames only. Pure footprint
      // hit-test against the in-closure geo map; a lagging closure just
      // delays the ring one render, same trade the tap handler accepts.
      let hoverEnterable = false;
      if (
        worldEnabled &&
        geoMap.entities.length > 0 &&
        (!page?.sceneView || page.sceneView.level === "map")
      ) {
        const pointer = normalizeClickOnImage(evt, img);
        if (pointer) {
          const frame = page?.sceneView?.map_crop ?? MAP_IMAGE_FRAME;
          hoverEnterable =
            focusOnMap(
              geoMap.entities.filter(
                (e) => e.kind === "place" && (e.parent_id ?? null) === null,
              ),
              frame,
              pointer,
            ) != null;
        }
      }
      setHoverPos({
        xPx: evt.clientX - rect.left,
        yPx: evt.clientY - rect.top,
        enterable: hoverEnterable,
      });
      if (editDragStartRef.current) {
        const s = editDragStartRef.current;
        const cur = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
        setEditDragRect({
          left: Math.min(s.x, cur.x),
          top: Math.min(s.y, cur.y),
          width: Math.abs(cur.x - s.x),
          height: Math.abs(cur.y - s.y),
        });
        return;
      }
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
      // Select-area edit: plain drag while editMode is on (every other image
      // gesture early-returns on editMode, so this is additive by construction).
      if (
        EDIT_REGION_ENABLED &&
        editMode &&
        evt.pointerType !== "touch" &&
        phase !== "generating"
      ) {
        const rect = img.getBoundingClientRect();
        editDragStartRef.current = {
          x: evt.clientX - rect.left,
          y: evt.clientY - rect.top,
        };
        evt.preventDefault();
        try {
          img.setPointerCapture(evt.pointerId);
        } catch {
          /* no-op */
        }
        return;
      }
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
      if (editDragStartRef.current) {
        const s = editDragStartRef.current;
        editDragStartRef.current = null;
        setEditDragRect(null);
        try {
          img.releasePointerCapture(evt.pointerId);
        } catch {
          /* no-op */
        }
        const rect = img.getBoundingClientRect();
        // A drag commits a selection; a plain click clears it.
        setEditRegion(
          dragToRegion(
            s,
            { x: evt.clientX - rect.left, y: evt.clientY - rect.top },
            rect.width,
            rect.height,
            img.naturalWidth,
            img.naturalHeight
          )
        );
        return;
      }
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
      // Same style lock as a click-tap: carry the medium exemplar so a freehand
      // "go inside" can't drift the art medium either (the parent grounds the
      // world; the style ref pins the medium).
      const strokeStyleRef =
        (styleAnchor
          ? history.items.find((p) => p.nodeId === styleAnchor.nodeId)
              ?.imageDataUrl
          : null) ??
        history.items.find((p) => p.parentId == null)?.imageDataUrl ??
        null;
      const strokeCondition = orderedRefs({
        parent: currentImage,
        style: strokeStyleRef !== currentImage ? strokeStyleRef : null,
      });
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
        ...loopWire,
        ...(devModel ? { image_model: devModel } : {}),
        output_locale: resolveOutputLocale(outputLocale),
        ...(strokeCondition.urls.length
          ? {
              condition_image_urls: strokeCondition.urls,
              condition_roles: strokeCondition.roles,
            }
          : {}),
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
  }, [page, phase, generate, imageTier, loopWire, devModel, editMode, outputLocale, bucketKey, streamStatus, styleAnchor, promptForHint, worldEnabled, worldAutonomy, history, selectFromMap]);

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
      ...loopWire,
      ...(devModel ? { image_model: devModel } : {}),
      output_locale: resolveOutputLocale(outputLocale),
      ...(styleAnchor ? { session_style_anchor: styleAnchor.style } : {}),
    });
  }, [generate, sessionId, imageTier, loopWire, devModel, outputLocale, styleAnchor]);

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
      // Dev knob: localStorage("openflipbook.ltxLoopyStrategy") overrides the
      // anchor-loop strategy per stream ("anchor_loop" | "linear").
      const loopyOverride = window.localStorage.getItem(
        "openflipbook.ltxLoopyStrategy",
      );
      streamRef.current = startLTXStream({
        wsUrl,
        video: videoRef.current,
        prompt: page.title,
        startImageDataUrl: page.imageDataUrl,
        onStatus: setStreamStatus,
        onError: (msg) => setError(msg),
        ...(loopyOverride === "anchor_loop" || loopyOverride === "linear"
          ? { loopyStrategy: loopyOverride }
          : {}),
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
        loopKnobs={loopKnobs}
        setLoopKnobs={setLoopKnobs}
        sessionSpend={sessionSpend}
        devModel={devModel}
        setDevModel={setDevModel}
        worldMode={worldEnabled}
        setWorldMode={setWorldEnabled}
        autonomy={worldAutonomy}
        setAutonomy={setWorldAutonomy}
        domLabels={worldDomLabels}
        setDomLabels={setWorldDomLabels}
      />

      {worldEnabled && (
        <div className="-mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void planWorld()}
            disabled={!input.trim() || phase === "generating"}
            title="Turn the text above into a logical object layout (asks if it's contradictory)"
            className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-40"
          >
            ✍ Describe a place
          </button>
        </div>
      )}

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
          {worldEnabled && (page?.parentId == null || ascendPending) && (
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={handleAscend}
                disabled={!canAscend}
                className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 hover:bg-[var(--color-ink)]/5 disabled:opacity-40"
                title="Zoom out to the place that contains this one (OUTWARD)"
              >
                {ascendPending ? "⤡ zooming out…" : "⤡ zoom out / step back"}
              </button>
              {ascendError && (
                <span className="text-red-700/80" title={ascendError}>
                  couldn’t zoom out
                </span>
              )}
            </div>
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
            {shared.viewers !== null && shared.viewers > 1 && (
              <span title="people viewing this session right now">
                {" "}
                · 👁 {shared.viewers}
              </span>
            )}
          </span>
          {shared.incoming && (
            <button
              type="button"
              onClick={() => {
                const id = shared.incoming?.id;
                shared.clearIncoming();
                if (id) selectFromMap(id);
              }}
              className="rounded-full border border-emerald-600/40 bg-emerald-50 px-3 py-1 text-xs text-emerald-900 hover:bg-emerald-100"
              title="A co-viewer added this page — click to open it"
            >
              ✦ new: {shared.incoming.title.slice(0, 32)} →
            </button>
          )}
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
          sceneViews={Object.fromEntries(
            history.items
              .filter((p): p is Page & { nodeId: string } => Boolean(p.nodeId))
              .map((p) => [p.nodeId, p.sceneView ?? null]),
          )}
        />
      ) : page?.imageDataUrl ? (
        <figure
          className="relative overflow-hidden rounded-2xl border border-[var(--color-ink)]/20 bg-white shadow-lg"
          onContextMenu={(e) => {
            if (!page?.imageDataUrl) return;
            e.preventDefault();
            // ContextMenu renders inside a fixed-positioned overlay, so it
            // anchors to the viewport — pass clientX/Y directly. Resolve what
            // is under the cursor while we're here: the menu is geo-aware.
            const imgEl = imgRef.current;
            const clickPct = imgEl
              ? normalizeClickOnImage(e.nativeEvent, imgEl)
              : null;
            const hit = clickPct
              ? entityAtPoint(
                  worldState.entities,
                  page?.nodeId ?? null,
                  clickPct.x_pct,
                  clickPct.y_pct
                )
              : null;
            setContextMenu({ xPx: e.clientX, yPx: e.clientY, clickPct, hit });
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
          {worldEnabled && (
            <button
              type="button"
              onClick={() => setWorldEnabled(false)}
              title="World Mode is ON — a tap ENTERS the tapped place (classic explore explains it instead). Click to switch back."
              className="pointer-events-auto absolute start-3 top-3 z-10 flex select-none items-center gap-1 rounded-full border border-emerald-700/40 bg-emerald-50/85 px-2.5 py-1 text-xs font-medium text-emerald-900 backdrop-blur transition hover:bg-emerald-100"
            >
              <span aria-hidden>🌍</span>
              <span>World — tap enters places</span>
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
                      hudEmit("morph:end", {
                        duration_ms: nowMs() - prev.startedAt,
                        t: nowMs(),
                      });
                      return null;
                    });
                  }}
                />
              )}
              {strokeState && <StrokeOverlay pxPoints={strokeState.pxPoints} />}

              {editMode && (editDragRect ?? editRegionDisplayRect) && (
                <RegionSelectOverlay
                  rect={(editDragRect ?? editRegionDisplayRect)!}
                />
              )}

              {editVerdictChip && (
                <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-black/70 px-3 py-1 text-xs text-white">
                  <span>{editVerdictChip.text}</span>
                  {editVerdictChip.revertTo && (
                    <button
                      type="button"
                      className="rounded-full bg-white/15 px-2 py-0.5 hover:bg-white/25"
                      title="Go back to the page as it was before this edit"
                      onClick={() => {
                        const id = editVerdictChip.revertTo;
                        setEditVerdictChip(null);
                        if (id) selectFromMap(id);
                      }}
                    >
                      ↩ revert
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Dismiss edit verdict"
                    className="opacity-60 hover:opacity-100"
                    onClick={() => setEditVerdictChip(null)}
                  >
                    ✕
                  </button>
                </div>
              )}

              {imgFailed && <ImageFailedOverlay />}

              {hoverPos &&
                phase !== "generating" &&
                !editMode &&
                streamStatus === "off" && (
                  <HoverCrosshair
                    xPx={hoverPos.xPx}
                    yPx={hoverPos.yPx}
                    enterable={hoverPos.enterable ?? false}
                  />
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
              {worldEnabled &&
                phase === "ready" &&
                streamStatus === "off" &&
                (!page?.sceneView || page.sceneView.level === "map") && (
                  <EnterableMarkers
                    entities={geoMap.entities}
                    currentView={page?.sceneView ?? null}
                    imgRef={imgRef}
                  />
                )}
              {worldEnabled &&
                worldDomLabels &&
                phase === "ready" &&
                streamStatus === "off" &&
                (!page?.sceneView || page.sceneView.level === "map") && (
                  <MapLabelOverlay
                    nodeId={page?.nodeId ?? null}
                    entities={worldState.entities}
                    geoEntities={geoMap.entities}
                    currentView={page?.sceneView ?? null}
                    imgRef={imgRef}
                  />
                )}
              {geoOverlayOn && page?.nodeId && (
                <GeometryOverlay
                  nodeId={page.nodeId}
                  entities={worldState.entities}
                  imgRef={imgRef}
                  onLocalize={() => void localizeCurrentNode()}
                  localizeStatus={
                    localizeStatus?.nodeId === page.nodeId
                      ? localizeStatus.status
                      : undefined
                  }
                  allowedEntityIds={
                    // Inside a place → only its own children's boxes (scoped to
                    // the current frame). At the top-level map → all (null).
                    page?.sceneView &&
                    page.sceneView.level !== "map" &&
                    page.sceneView.focus_id
                      ? new Set(
                          childrenOf(geoMap.entities, page.sceneView.focus_id)
                            .map((g) => g.entity_id)
                            .filter((id): id is string => id != null),
                        )
                      : null
                  }
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
                  setEditRegion(null);
                  setEditDragRect(null);
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
                style={editFormStyle}
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
        geoEditPrefill={geoEditPrefill}
        onGeoApplyToImage={geoApplyToImage}
      />

      {/* Hide the coach while the Around tray is open — both are pinned to
          bottom-centre, so they'd overlap; mid-bloom the hint is noise anyway.
          It returns when the tray is closed. */}
      {phase === "ready" && !helpOpen && !bloom && history.items.length <= 1 && (
        <FirstRunCoach
          onShowHelp={() => setHelpOpen(true)}
          worldHint={worldEnabled}
        />
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
          extraItems={contextExtraItems}
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
