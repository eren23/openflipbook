"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import type {
  GenerateRequestBody,
  GenerateEvent,
} from "@openflipbook/config";
import { annotateClickPoint, normalizeClickOnImage } from "@/lib/image-click";
import {
  getWSUrl,
  startLTXStream,
  type StreamClient,
  type StreamStatus,
} from "@/lib/stream-client";
import WorldMap from "@/components/world-map";

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
  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<StreamClient | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus | "off">("off");
  const [fallbackVideoUrl, setFallbackVideoUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);

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
      });
    },
    [input, sessionId, page, generate]
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
    const handler = async (evt: MouseEvent) => {
      if (phase === "generating") return;
      const click = normalizeClickOnImage(evt, img);
      if (!click) return;
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
      });
    };
    img.addEventListener("click", handler);
    return () => img.removeEventListener("click", handler);
  }, [page, phase, generate]);

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
    });
  }, [generate, sessionId]);

  const disconnectStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    setStreamStatus("off");
    setFallbackVideoUrl(null);
  }, []);

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
    // Cheap fallback via fal.
    setStreamStatus("connecting");
    try {
      const res = await fetch("/api/animate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_data_url: page.imageDataUrl,
          prompt: page.title,
        }),
      });
      const data = (await res.json()) as {
        video_url?: string;
        error?: string;
      };
      if (!res.ok || !data.video_url) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setFallbackVideoUrl(data.video_url);
      setStreamStatus("playing");
    } catch (err) {
      setStreamStatus("error");
      setError((err as Error).message);
    }
  }, [page]);

  return (
    <main
      className="relative mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 px-4 py-6"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <form
        onSubmit={submitQuery}
        className="flex items-center gap-2 rounded-full border border-[var(--color-ink)]/30 bg-white/80 px-4 py-2 shadow-sm"
      >
        <input
          autoFocus
          className="flex-1 bg-transparent outline-none placeholder:opacity-60"
          placeholder="Ask about anything, or upload a seed image..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={phase === "generating"}
          className="rounded-full border border-[var(--color-ink)]/40 px-3 py-1 text-xs hover:bg-[var(--color-ink)]/5 disabled:opacity-40"
          title="Upload an image as the starting page. Tap on it to explore regions."
        >
          ⬆ Upload
        </button>
        <button
          type="submit"
          disabled={phase === "generating" || input.trim().length === 0}
          className="rounded-full bg-[var(--color-ink)] px-4 py-1 text-[var(--color-canvas)] disabled:opacity-40"
        >
          {phase === "generating" ? "…" : "Go"}
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
          <div className="relative">
            <div
              className="relative"
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
              {streamStatus === "off" || streamStatus === "error" ? (
                <img
                  ref={imgRef}
                  src={page.imageDataUrl}
                  alt={`Generated illustration for ${page.query}`}
                  className="block h-auto w-full cursor-crosshair select-none"
                  draggable={false}
                />
              ) : fallbackVideoUrl ? (
                <video
                  src={fallbackVideoUrl}
                  className="block h-auto w-full"
                  autoPlay
                  loop
                  muted
                  playsInline
                  controls
                />
              ) : (
                <video
                  ref={videoRef}
                  className="block h-auto w-full"
                  autoPlay
                  muted
                  playsInline
                  controls
                />
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

            <button
              type="button"
              onClick={streamStatus === "off" ? connectStream : disconnectStream}
              className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs text-white"
              title={
                process.env.NEXT_PUBLIC_LTX_WS_URL
                  ? "Stream an animated clip from Modal LTX"
                  : "Generate a 5-second clip via fal-ai/ltx-video (not streaming — full MP4)"
              }
            >
              {streamStatus === "off"
                ? process.env.NEXT_PUBLIC_LTX_WS_URL
                  ? "Animate (stream)"
                  : "Animate (5s clip)"
                : streamStatus === "playing"
                  ? "Stop"
                  : streamStatus === "connecting"
                    ? "Generating clip…"
                    : `… ${streamStatus}`}
            </button>
            <figcaption className="absolute bottom-0 left-0 right-0 bg-black/50 px-4 py-2 text-sm text-white">
              Tap anywhere on the image to explore.
            </figcaption>
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
