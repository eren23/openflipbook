"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import type {
  GenerateRequestBody,
  GenerateEvent,
  ImageTier,
  VideoTier,
} from "@openflipbook/config";
import { annotateClickPoint, normalizeClickOnImage } from "@/lib/image-click";
import {
  getWSUrl,
  startLTXStream,
  type StreamClient,
  type StreamStatus,
} from "@/lib/stream-client";
import WorldMap from "@/components/world-map";
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  getStrings,
  isRTL,
  resolveOutputLocale,
} from "@/lib/i18n";

type Theme = "light" | "sepia" | "dark";
const THEMES: readonly Theme[] = ["light", "sepia", "dark"] as const;

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
  body: PersistBody
): Promise<{ id: string; image_url: string } | null> {
  try {
    const res = await fetch("/api/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as { id: string; image_url: string };
  } catch {
    return null;
  }
}

export default function PlayPage() {
  const [input, setInput] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [sessionId] = useState(initialSessionId);
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
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [clickRipple, setClickRipple] = useState<{
    xPx: number;
    yPx: number;
    key: number;
  } | null>(null);
  const [zoomFx, setZoomFx] = useState<{
    ox: number;
    oy: number;
    phase: "in" | "out";
  } | null>(null);
  const [hoverPos, setHoverPos] = useState<{ xPx: number; yPx: number } | null>(
    null
  );
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
  const [imageTier, setImageTier] = useState<ImageTier>("balanced");
  const [videoTier, setVideoTier] = useState<VideoTier>("fast");
  const [outputLocale, setOutputLocale] = useState<SupportedLocale>("auto");
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const it = window.localStorage.getItem("openflipbook.tier");
    if (it === "fast" || it === "balanced" || it === "pro") setImageTier(it);
    const vt = window.localStorage.getItem("openflipbook.videoTier");
    if (vt === "fast" || vt === "balanced" || vt === "pro") setVideoTier(vt);
    const ol = window.localStorage.getItem("openflipbook.outputLocale");
    if (ol && (SUPPORTED_LOCALES as readonly string[]).includes(ol)) {
      setOutputLocale(ol as SupportedLocale);
    }
    const th = window.localStorage.getItem("openflipbook.theme");
    if (th === "light" || th === "sepia" || th === "dark") setTheme(th);
  }, []);

  const firstImageTierRun = useRef(true);
  useEffect(() => {
    if (firstImageTierRun.current) {
      firstImageTierRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem("openflipbook.tier", imageTier);
  }, [imageTier]);
  const proWarnedRef = useRef(false);
  useEffect(() => {
    if (imageTier === "pro" && !proWarnedRef.current) {
      proWarnedRef.current = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[openflipbook] pro tier uses a slower + pricier image model — switch back to balanced for snappier exploration."
      );
    }
  }, [imageTier]);

  const firstVideoTierRun = useRef(true);
  useEffect(() => {
    if (firstVideoTierRun.current) {
      firstVideoTierRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem("openflipbook.videoTier", videoTier);
  }, [videoTier]);

  const [editMode, setEditMode] = useState(false);
  const [editInstruction, setEditInstruction] = useState("");

  const firstOutputLocaleRun = useRef(true);
  useEffect(() => {
    if (firstOutputLocaleRun.current) {
      firstOutputLocaleRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem("openflipbook.outputLocale", outputLocale);
    const head = resolveOutputLocale(outputLocale);
    document.documentElement.setAttribute("lang", head);
    document.documentElement.setAttribute("dir", isRTL(head) ? "rtl" : "ltr");
  }, [outputLocale]);
  const t = getStrings(outputLocale);

  const firstThemeRun = useRef(true);
  useEffect(() => {
    if (firstThemeRun.current) {
      firstThemeRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem("openflipbook.theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Hover-prefetch cache. Keyed by `${nodeId}:${xBucket}:${yBucket}` so two
  // hovers within a 5% grid cell reuse the same VLM round-trip.
  //
  // Bandwidth/cost discipline (each prefetch POSTs ~1-3MB image data + spends
  // OpenRouter VLM tokens):
  //   - serial: only one in-flight request at a time; new hover aborts prior
  //   - per-page cap: at most PREFETCH_PER_PAGE distinct buckets warmed
  //   - LRU eviction at PREFETCH_LRU_MAX so long sessions don't grow Map<>
  //   - debounce 450ms below filters out fast pointer sweeps
  const PREFETCH_PER_PAGE = 6;
  const PREFETCH_LRU_MAX = 200;
  const prefetchCacheRef = useRef<
    Map<string, { subject: string; style: string }>
  >(new Map());
  const prefetchInflightRef = useRef<Map<string, AbortController>>(new Map());
  const prefetchTimerRef = useRef<number | null>(null);
  const prefetchCurrentKeyRef = useRef<string | null>(null);
  const prefetchPerPageCountRef = useRef<Map<string, number>>(new Map());

  const bucketKey = useCallback(
    (nodeId: string | null, xPct: number, yPct: number): string => {
      const xb = Math.round(xPct * 20); // 5% grid
      const yb = Math.round(yPct * 20);
      return `${nodeId ?? "noid"}:${xb}:${yb}`;
    },
    []
  );

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

      try {
        const response = await fetch("/api/generate-page", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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
              setPage({
                nodeId: null,
                sessionId: evt.session_id,
                query: body.query,
                title: evt.page_title,
                imageDataUrl: evt.image_data_url,
              });
              void persistNode({
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
              }).then((saved) => {
                if (saved) {
                  const persisted: Page = {
                    nodeId: saved.id,
                    sessionId: evt.session_id,
                    query: body.query,
                    title: evt.page_title,
                    imageDataUrl: evt.image_data_url,
                    parentId: body.current_node_id || null,
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
                    prev ? { ...prev, nodeId: saved.id } : prev
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
                }
              });
            } else if (evt.type === "error") {
              throw new Error(evt.message);
            }
          }
        }
        setPhase("ready");
        setStatusMsg(null);
        setZoomFx((prev) => (prev ? { ...prev, phase: "out" } : null));
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setZoomFx(null);
          return;
        }
        setError((err as Error).message);
        setPhase("error");
        setZoomFx(null);
      }
    },
    []
  );

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
        void persistNode({
          parent_id: null,
          session_id: sessionId,
          query: seedQuery,
          page_title: seedTitle,
          image_data_url: dataUrl,
          image_model: "user-upload",
          prompt_author_model: "user-upload",
          aspect_ratio: "16:9",
          final_prompt: "",
        }).then((saved) => {
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
          }
        });
      } catch (err) {
        setError((err as Error).message);
        setPhase("error");
      }
    },
    [sessionId]
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
      });
    },
    [input, sessionId, page, generate, imageTier, outputLocale]
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
      });
      setEditInstruction("");
      setEditMode(false);
    },
    [editInstruction, page, generate, imageTier, outputLocale]
  );

  const canGoBack = history.trailIdx > 0;
  const canGoForward = history.trailIdx < history.trail.length - 1;

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
    setZoomFx(null);
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
      setZoomFx(null);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
      } else if (e.key.toLowerCase() === "m") {
        e.preventDefault();
        setViewMode((m) => (m === "map" ? "page" : "map"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goBack, goForward]);

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
        const res = await fetch(`/api/sessions/${encodeURIComponent(cont)}`);
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
          };
          if (data.subject) {
            cache.set(key, {
              subject: data.subject,
              style: data.style ?? "",
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

    const handler = async (evt: MouseEvent) => {
      if (phase === "generating") return;
      if (editMode) return;
      const click = normalizeClickOnImage(evt, img);
      if (!click) return;
      // Cmd (mac) / Ctrl (other) + click → ask the user for an extra angle on
      // the click point ("cross-section view", "explain like I'm 5"). Captured
      // before any zoom/ripple state so the prompt is the first thing they see.
      let hint = "";
      if (evt.metaKey || evt.ctrlKey) {
        const raw = window.prompt(
          "Add a note for this click (optional — e.g. 'cross-section', 'for a 5-year-old'):"
        );
        if (raw === null) return; // user cancelled
        hint = raw.trim().slice(0, 240);
      }
      const rect = img.getBoundingClientRect();
      const px = evt.clientX - rect.left;
      const py = evt.clientY - rect.top;
      setClickRipple({ xPx: px, yPx: py, key: Date.now() });
      setZoomFx({ ox: px, oy: py, phase: "in" });
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
      const cached = hint
        ? undefined
        : cache.get(bucketKey(currentNodeId, click.x_pct, click.y_pct));
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
        ...(hint ? { click_hint: hint } : {}),
        ...(cached
          ? {
              prefetched_subject: cached.subject,
              prefetched_style: cached.style,
            }
          : {}),
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
      const click = normalizeClickOnImage(evt, img);
      if (!click) return;
      if (prefetchTimerRef.current !== null) {
        window.clearTimeout(prefetchTimerRef.current);
      }
      prefetchTimerRef.current = window.setTimeout(() => {
        firePrefetch(click.x_pct, click.y_pct);
      }, 450);
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
    img.addEventListener("pointermove", move);
    img.addEventListener("pointerleave", leave);
    return () => {
      img.removeEventListener("click", handler);
      img.removeEventListener("pointermove", move);
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
  }, [page, phase, generate, imageTier, editMode, outputLocale, bucketKey, streamStatus]);

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
    });
  }, [generate, sessionId, imageTier, outputLocale]);

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
      <form
        onSubmit={submitQuery}
        className="flex flex-wrap items-center gap-2 rounded-full border border-[var(--color-edge)] bg-[var(--color-canvas)]/80 px-4 py-2 shadow-sm"
      >
        <input
          autoFocus
          className="min-w-[8rem] flex-1 bg-transparent outline-none placeholder:opacity-60"
          placeholder={t.placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={phase === "generating"}
          className="rounded-full border border-[var(--color-edge)] px-3 py-1 text-xs hover:bg-[var(--color-ink)]/5 disabled:opacity-40"
          title="Upload an image as the starting page. Tap on it to explore regions."
        >
          {t.upload}
        </button>
        <select
          value={outputLocale}
          onChange={(e) => setOutputLocale(e.target.value as SupportedLocale)}
          disabled={phase === "generating"}
          aria-label={t.langLabel}
          title={t.langLabel}
          className="rounded-full border border-[var(--color-edge)] bg-transparent px-2 py-1 text-xs disabled:opacity-40"
        >
          {SUPPORTED_LOCALES.map((loc) => (
            <option key={loc} value={loc}>
              {loc === "auto" ? t.langAuto : loc}
            </option>
          ))}
        </select>
        <div
          role="group"
          aria-label="Theme"
          className="flex items-center overflow-hidden rounded-full border border-[var(--color-edge)] text-xs"
          title="Theme — light / sepia / dark"
        >
          {THEMES.map((th) => (
            <button
              key={th}
              type="button"
              onClick={() => setTheme(th)}
              aria-pressed={theme === th}
              className={
                "px-2.5 py-1 transition-colors " +
                (theme === th
                  ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                  : "hover:bg-[var(--color-ink)]/5")
              }
            >
              {th === "light"
                ? t.themeLight
                : th === "sepia"
                  ? t.themeSepia
                  : t.themeDark}
            </button>
          ))}
        </div>
        <div
          role="group"
          aria-label="Image quality tier"
          className="flex items-center overflow-hidden rounded-full border border-[var(--color-edge)] text-xs"
          title="Image quality tier — fast (cheap), balanced (default), pro (premium)"
        >
          <span className="px-2 py-1 opacity-60">image</span>
          {(["fast", "balanced", "pro"] as const).map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setImageTier(tier)}
              disabled={phase === "generating"}
              aria-pressed={imageTier === tier}
              className={
                "px-2.5 py-1 transition-colors disabled:opacity-40 " +
                (imageTier === tier
                  ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                  : "hover:bg-[var(--color-ink)]/5")
              }
            >
              {tier}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={phase === "generating" || input.trim().length === 0}
          className="rounded-full bg-[var(--color-ink)] px-4 py-1 text-[var(--color-canvas)] disabled:opacity-40"
        >
          {phase === "generating" ? t.generating : t.go}
        </button>
      </form>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFileInputChange}
      />

      {isDraggingFile && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/40 text-center text-lg text-white">
          <div className="rounded-2xl border-2 border-dashed border-white/80 px-10 py-8">
            Drop an image to start from it
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="rounded-lg border border-red-500 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {page?.imageDataUrl && history.items.length > 0 && (
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
          </div>
          <span className="opacity-60">
            step {history.trailIdx + 1} of {history.trail.length}
            {history.items.length > history.trail.length
              ? ` · ${history.items.length} pages explored`
              : ""}
          </span>
        </div>
      )}

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
        <figure className="overflow-hidden rounded-2xl border border-[var(--color-ink)]/20 bg-white shadow-lg">
          <div className="relative aspect-[16/9] w-full">
            <div
              className="relative h-full w-full"
              style={
                zoomFx
                  ? {
                      transform: `scale(${zoomFx.phase === "in" ? 1.6 : 1})`,
                      transformOrigin: `${zoomFx.ox}px ${zoomFx.oy}px`,
                      transition:
                        zoomFx.phase === "in"
                          ? "transform 700ms cubic-bezier(0.22, 0.61, 0.36, 1)"
                          : "transform 380ms cubic-bezier(0.22, 0.61, 0.36, 1)",
                      willChange: "transform",
                    }
                  : undefined
              }
              onTransitionEnd={(e) => {
                if (e.propertyName !== "transform") return;
                setZoomFx((prev) =>
                  prev?.phase === "out" ? null : prev
                );
              }}
            >
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
                <img
                  ref={imgRef}
                  src={page.imageDataUrl}
                  alt={`Generated illustration for ${page.query}`}
                  onError={() => setImgFailed(true)}
                  className={
                    "block h-full w-full object-contain select-none " +
                    (streamStatus === "connecting"
                      ? "cursor-wait"
                      : phase === "generating" || editMode
                        ? "cursor-crosshair"
                        : "cursor-none")
                  }
                  draggable={false}
                />
              )}
              {imgFailed && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/70 p-6 text-center text-white">
                  <div className="max-w-md text-sm leading-relaxed">
                    Couldn&apos;t load this page&apos;s image. The persisted R2
                    link may have expired or the bucket&apos;s public access is
                    off. Type a new query above and hit Go to start fresh.
                  </div>
                </div>
              )}

              {hoverPos &&
                phase !== "generating" &&
                !editMode &&
                streamStatus === "off" && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
                    style={{
                      left: `${hoverPos.xPx}px`,
                      top: `${hoverPos.yPx}px`,
                      width: "28px",
                      height: "28px",
                    }}
                  >
                    <svg
                      viewBox="0 0 28 28"
                      width="28"
                      height="28"
                      className="block"
                    >
                      <circle
                        cx="14"
                        cy="14"
                        r="11"
                        fill="none"
                        stroke="rgba(255,255,255,0.95)"
                        strokeWidth="2.5"
                      />
                      <circle
                        cx="14"
                        cy="14"
                        r="11"
                        fill="none"
                        stroke="#ef4444"
                        strokeWidth="1.25"
                      />
                      <line
                        x1="14"
                        y1="2"
                        x2="14"
                        y2="9"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                      />
                      <line
                        x1="14"
                        y1="19"
                        x2="14"
                        y2="26"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                      />
                      <line
                        x1="2"
                        y1="14"
                        x2="9"
                        y2="14"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                      />
                      <line
                        x1="19"
                        y1="14"
                        x2="26"
                        y2="14"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                      />
                      <circle cx="14" cy="14" r="1.5" fill="#ef4444" />
                    </svg>
                  </span>
                )}

              {clickRipple && phase === "generating" && (
                <span
                  key={clickRipple.key}
                  aria-hidden
                  className="pointer-events-none absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 shadow-lg"
                  style={{
                    left: `${clickRipple.xPx}px`,
                    top: `${clickRipple.yPx}px`,
                    animation: "ec-ripple 1.2s ease-out infinite",
                  }}
                />
              )}
            </div>

            {/* Beacons: small markers at click points where children exist. */}
            {page?.nodeId &&
              (streamStatus === "off" || streamStatus === "error") &&
              history.items
                .filter(
                  (
                    p
                  ): p is Page & {
                    nodeId: string;
                    clickInParent: { xPct: number; yPct: number };
                  } =>
                    Boolean(
                      p.nodeId &&
                        p.parentId === page.nodeId &&
                        p.clickInParent
                    )
                )
                .map((kid) => (
                  <button
                    key={kid.nodeId}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      selectFromMap(kid.nodeId);
                    }}
                    className="group absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                    style={{
                      left: `${kid.clickInParent.xPct * 100}%`,
                      top: `${kid.clickInParent.yPct * 100}%`,
                    }}
                    title={`Branch: ${kid.title}`}
                    aria-label={`Open branch: ${kid.title}`}
                  >
                    <span className="absolute inline-block h-7 w-7 rounded-full bg-white/0 ring-1 ring-white/0 transition-all group-hover:bg-white/30 group-hover:ring-white/80" />
                    <span className="relative inline-block h-2.5 w-2.5 rounded-full bg-white/55 shadow-[0_0_0_1.5px_rgba(0,0,0,0.45)] transition-all group-hover:h-3.5 group-hover:w-3.5 group-hover:bg-red-400 group-hover:shadow-[0_0_0_2px_rgba(0,0,0,0.7)]" />
                  </button>
                ))}

            {phase === "generating" && (
              <div className="pointer-events-none absolute inset-0 flex items-end bg-black/35">
                <div className="m-4 flex items-center gap-3 rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg">
                  <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-white/90" />
                  <span>{statusMsg ?? "Generating…"}</span>
                </div>
              </div>
            )}

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
              <form
                onSubmit={submitEdit}
                className="absolute bottom-0 left-0 right-0 flex items-center gap-2 bg-black/65 px-3 py-2"
              >
                <input
                  autoFocus
                  value={editInstruction}
                  onChange={(e) => setEditInstruction(e.target.value)}
                  placeholder={t.editPlaceholder}
                  className="flex-1 rounded-full bg-white/95 px-3 py-1 text-sm text-black outline-none placeholder:opacity-60"
                />
                <button
                  type="submit"
                  disabled={
                    phase === "generating" || editInstruction.trim().length === 0
                  }
                  className="rounded-full bg-amber-500 px-3 py-1 text-xs text-black disabled:opacity-50"
                >
                  {t.apply}
                </button>
              </form>
            ) : (
              <figcaption className="absolute bottom-0 left-0 right-0 bg-black/50 px-4 py-2 text-sm text-white">
                {t.tapHint}
              </figcaption>
            )}
          </div>
        </figure>
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
    </main>
  );
}
