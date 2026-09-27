"use client";
/* eslint-disable @next/next/no-img-element -- data-URL and R2 previews; next/image cannot optimize data URIs */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  FolderOpen,
  ImagePlus,
  Layers,
  Map,
  ScanSearch,
  Box,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  blankSketch,
  parseSketch,
  SKETCH_MODELS,
  SKETCH_RESERVATION,
  SKETCH_WORKFLOWS,
  SKETCH_OUTPUTS,
  SKETCH_MATERIALS,
  SKETCH_VIEWS,
  sketchWorkflowError,
  type SketchState,
  type SketchDocument,
  type SketchCandidate,
} from "@/lib/sketch-types";
import {
  download,
  exportBundle,
  fileData,
  imageSize,
  importSketch,
} from "@/lib/sketch-files";
import type { SketchCanvasHandle } from "./sketch-canvas";
import s from "./sketch.module.css";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";
import { sketchExample } from "@/lib/sketch-examples";
import { mapReviewBounds } from "@/lib/map-artwork";

const Canvas = dynamic(() => import("./sketch-canvas"), {
  ssr: false,
  loading: () => <div className={s.loading}>Loading drawing tools...</div>,
});
async function request(url: string, body?: unknown, method = "POST") {
  const res = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not save sketch");
  return data;
}
export default function SketchWorkspace() {
  const [state, setState] = useState<SketchState>(blankSketch);
  const [doc, setDoc] = useState<SketchDocument | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SketchCandidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(50);
  const [focusMap, setFocusMap] = useState(true);
  const review = doc?.map_repaint && focusMap ? mapReviewBounds(state) : null;
  const reviewImage = review ? { position: "absolute" as const, width: `${state.frame.width / review.width * 100}%`, height: `${state.frame.height / review.height * 100}%`, left: `${-review.x / review.width * 100}%`, top: `${-review.y / review.height * 100}%`, objectFit: "fill" as const } : undefined;
  const [loadedCandidate, setLoadedCandidate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [settings, setSettings] = useState(false);
  const [library, setLibrary] = useState<SketchDocument[] | null>(null);
  const [ready, setReady] = useState(false);
  const canvas = useRef<SketchCanvasHandle>(null);
  const input = useRef<HTMLInputElement>(null),
    styleInput = useRef<HTMLInputElement>(null),
    subjectInput = useRef<HTMLInputElement>(null);
  const stateRef = useRef(state),
    docRef = useRef(doc),
    sourceRef = useRef(source);
  stateRef.current = state;
  docRef.current = doc;
  sourceRef.current = source;
  const savedState = useRef("");
  const pendingRequest = useRef<{ signature: string; key: string } | null>(
    null,
  );
  const saveQueue = useRef<Promise<SketchDocument | null>>(
    Promise.resolve(null),
  );
  const change = useCallback((next: SketchState) => {
    stateRef.current = next;
    setState(next);
    setDirty(true);
    setCandidates((old) => old.map((c) => ({ ...c, matches_draft: false })));
  }, []);
  const persist = useCallback(async (): Promise<SketchDocument> => {
    const work = saveQueue.current
      .catch(() => null)
      .then(async () => {
        const snapshot = parseSketch(stateRef.current),
          current = docRef.current;
        const serialized = JSON.stringify(snapshot);
        if (current && serialized === savedState.current) return current;
        setSaving(true);
        try {
          const data = current
            ? await request(
                `/api/sketches/${current.id}`,
                { state: snapshot, revision: current.revision },
                "PUT",
              )
            : await request("/api/sketches", {
                state: snapshot,
                ...(sourceRef.current
                  ? { source_data_url: sourceRef.current }
                  : {}),
              });
          docRef.current = data.sketch;
          setDoc(data.sketch);
          savedState.current = serialized;
          setDirty(
            JSON.stringify(parseSketch(stateRef.current)) !== serialized,
          );
          window.history.replaceState({}, "", `/sketch?id=${data.sketch.id}`);
          return data.sketch as SketchDocument;
        } finally {
          setSaving(false);
        }
      });
    saveQueue.current = work;
    return work;
  }, []);
  const load = useCallback(async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const data = await request(`/api/sketches/${id}`);
      const d: SketchDocument = data.sketch;
      const src = d.source_url
        ? await fileData(
            await (await fetch(`/api/sketches/${id}/source`)).blob(),
          )
        : null;
      setSource(src);
      sourceRef.current = src;
      docRef.current = d;
      stateRef.current = d.state;
      savedState.current = JSON.stringify(d.state);
      setDoc(d);
      setState(d.state);
      setCandidates(data.candidates);
      setSelected(
        data.candidates.find((c: SketchCandidate) => c.status === "ready")
          ?.id ?? null,
      );
      setDirty(false);
      setCompare(false);
      setEpoch((v) => v + 1);
      setLibrary(null);
      window.history.replaceState({}, "", `/sketch?id=${id}`);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(location.search);
    (async () => {
      if (params.get("id")) await load(params.get("id")!);
      else if (params.has("example")) {
        const example = sketchExample(params.get("example"));
        if (!example) throw new Error("Unknown sketch example");
        const response = await fetch(example.image);
        if (!response.ok) throw new Error("Example image could not be loaded");
        const src = await fileData(await response.blob());
        const frame = await imageSize(src);
        if (cancelled) return;
        const next = { ...example.state, frame };
        setState(next); stateRef.current = next;
        setSource(src); sourceRef.current = src; setEpoch(v => v + 1);
      }
      else if (params.get("source")) {
        setBusy(true);
        const res = await fetch(
          `/api/image/${encodeURIComponent(params.get("source")!)}`,
        );
        if (!res.ok) throw new Error("Source image could not be loaded");
        const src = await fileData(await res.blob());
        const frame = await imageSize(src);
        if (cancelled) return;
        const data = await request("/api/sketches", {
          source_node_id: params.get("source"),
          state: { ...blankSketch(), title: "Image correction", frame },
        });
        await load(data.sketch.id);
      }
    })()
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [load]);
  useEffect(() => {
    if (!ready || !dirty || busy) return;
    const timer = setTimeout(() => {
      void persist().catch((e) => setError(e.message));
    }, 1400);
    return () => clearTimeout(timer);
  }, [state, ready, dirty, busy, persist]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty || busy) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  const active = candidates.find((c) => c.id === selected);
  const workflow = state.workflow ?? "render";
  async function run() {
    setBusy(true);
    setError("");
    try {
      const workflowError = sketchWorkflowError(
        stateRef.current,
        Boolean(sourceRef.current),
      );
      if (workflowError) throw new Error(workflowError);
      const exports = await canvas.current?.export(true);
      if (!exports) throw new Error("Drawing is still loading");
      const d = await persist();
      const signature = `${d.id}:${d.revision}`;
      const storageKey = `ofb-sketch-request:${signature}`;
      if (pendingRequest.current?.signature !== signature) {
        let key: string | null = null;
        try {
          key = sessionStorage.getItem(storageKey);
        } catch {
          /* Storage may be disabled. */
        }
        pendingRequest.current = { signature, key: key || crypto.randomUUID() };
      }
      try {
        sessionStorage.setItem(storageKey, pendingRequest.current.key);
      } catch {
        /* In-memory retry still works. */
      }
      const res = await fetch("/api/generate-page", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": pendingRequest.current.key,
        },
        body: JSON.stringify({
          sketch_id: d.id,
          sketch_revision: d.revision,
          sketch_exports: exports,
          session_id: d.session_id,
          mode: "edit",
          query: state.prompt || "Create from sketch",
        }),
      });
      const data = await res.json();
      if (data.candidate) {
        setCandidates((old) => [
          data.candidate,
          ...old.filter((c) => c.id !== data.candidate.id),
        ]);
        setSelected(data.candidate.id);
        if (data.candidate.status !== "running") {
          pendingRequest.current = null;
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            /* Storage may be disabled. */
          }
        }
      }
      if (!res.ok) throw new Error(data.error || "Generation failed");
      if (data.candidate?.status === "running")
        throw new Error(
          "This generation is still running. Reopen the drawing shortly; it will not be charged again.",
        );
      setCompare(data.candidate?.status === "ready");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function keep() {
    if (!doc || !active) return;
    setBusy(true);
    setError("");
    try {
      const data = await request(`/api/sketches/${doc.id}/accept`, {
        candidate_id: active.id,
        revision: doc.revision,
      });
      setCandidates((old) =>
        old.map((c) =>
          c.id === active.id ? { ...c, saved_node_id: data.node_id } : c,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (dirty) await persist();
      let next: SketchState;
      let src: string | undefined;
      if (file.type.startsWith("image/")) {
        src = await fileData(file);
        next = {
          ...blankSketch(),
          title: file.name.replace(/\.[^.]+$/, ""),
          frame: await imageSize(src),
        };
      } else {
        const imported = await importSketch(file);
        next = imported.state;
        src = imported.source;
      }
      const data = await request("/api/sketches", {
        state: next,
        ...(src ? { source_data_url: src } : {}),
      });
      await load(data.sketch.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportFile(kind: "png" | "bundle" | "scene") {
    try {
      if (kind === "scene") {
        download(
          new Blob(
            [
              JSON.stringify({
                type: "excalidraw",
                version: 2,
                source: "openflipbook",
                ...state.scene,
                appState: { viewBackgroundColor: "#ffffff" },
              }),
            ],
            { type: "application/json" },
          ),
          `${state.title}.excalidraw`,
        );
        return;
      }
      if (kind === "png" && active?.image_url && compare) {
        download(
          await (await fetch(active.image_url)).blob(),
          `${state.title}.png`,
        );
        return;
      }
      const result = await canvas.current?.export();
      if (!result) throw new Error("Return to the drawing to export it");
      if (kind === "bundle")
        download(
          await exportBundle(state, source, result.guide, result.mask),
          `${state.title}.ofb-sketch`,
        );
      else
        download(
          await (await fetch(result.guide)).blob(),
          `${state.title}.png`,
        );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function newSketch(skipSave = false) {
    if (dirty && !skipSave) await persist();
    setDoc(null);
    docRef.current = null;
    setSource(null);
    sourceRef.current = null;
    const next = blankSketch();
    setState(next);
    stateRef.current = next;
    setCandidates([]);
    setSelected(null);
    setCompare(false);
    setDirty(false);
    savedState.current = "";
    setEpoch((v) => v + 1);
    window.history.replaceState({}, "", "/sketch");
  }
  return (
    <main className={s.workspace}>
      <header className={s.header}>
        <a href="/" className={s.back} title="My Worlds">
          <ArrowLeft size={17} />
          <span>openflipbook</span>
        </a>
        <span className={s.divider} />
        <strong>Sketch</strong>
        {placeScenesEnabled() && (active?.saved_node_id || doc?.source_node_id) && <button className={s.icon} title="World editor" aria-label="World editor" disabled={busy} onClick={() => { void persist().then(d => { window.location.href = `/sketch/world?source=${encodeURIComponent(d.map_repaint?.scene_source_node_id || active?.saved_node_id || d.source_node_id!)}&draft=${encodeURIComponent(d.id)}`; }).catch(e => setError(e.message)); }}><Box size={18} /></button>}
        {doc?.map_repaint && <a className={s.icon} title={`Map artwork / geometry r${doc.map_repaint.scene_revision}`} aria-label="Map artwork" href={`/sketch/world/map?source=${encodeURIComponent(doc.map_repaint.scene_source_node_id)}`}><Map size={18} /></a>}
        <input
          className={s.title}
          aria-label="Sketch title"
          value={state.title}
          maxLength={160}
          disabled={busy}
          onChange={(e) => change({ ...state, title: e.target.value })}
        />
        <span className={s.saved} role="status">
          {saving
            ? "Saving..."
            : dirty
              ? "Unsaved"
              : doc
                ? "Saved"
                : "New drawing"}
        </span>
        <button
          className={s.icon}
          title="Save drawing"
          aria-label="Save drawing"
          disabled={busy || saving}
          onClick={() => void persist().catch((e) => setError(e.message))}
        >
          <Save size={17} />
        </button>
        <button
          className={s.icon}
          title="Open sketches"
          aria-label="Open sketches"
          disabled={busy}
          onClick={() =>
            void request("/api/sketches")
              .then((d) => setLibrary(d.sketches))
              .catch((e) => setError(e.message))
          }
        >
          <FolderOpen size={18} />
        </button>
        <button
          className={s.icon}
          title="New sketch"
          aria-label="New sketch"
          disabled={busy}
          onClick={() => void newSketch().catch((e) => setError(e.message))}
        >
          <Plus size={19} />
        </button>
        <button
          className={`${s.icon} ${s.mobileSettings}`}
          title="Generation settings"
          aria-label="Generation settings"
          onClick={() => setSettings(!settings)}
        >
          <Settings2 size={18} />
        </button>
      </header>
      {error && (
        <div className={s.error} role="alert">
          <span>{error}</span>
          <button
            title="Dismiss error"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className={s.body}>
        <section className={s.workArea} aria-label="Artwork">
          <div className={s.viewBar}>
            <div className={s.segment} role="group" aria-label="Workspace view">
              <button aria-pressed={!compare} onClick={() => setCompare(false)}>
                <Pencil size={15} />
                Draw
              </button>
              <button
                aria-pressed={compare}
                disabled={!active?.image_url}
                onClick={() => setCompare(true)}
              >
                <Layers size={15} />
                Compare
              </button>
            </div>
            <span>
              {state.frame.width} x {state.frame.height}
            </span>
            <button
              title="Import image or sketch"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <ImagePlus size={16} />
              Import
            </button>
          </div>
          <div
            className={s.canvasStage}
            style={{
              display: compare && active?.image_url ? "none" : undefined,
            }}
          >
            {ready && (
              <Canvas
                key={epoch}
                ref={canvas}
                state={state}
                source={source}
                disabled={busy}
                onChange={(scene) => change({ ...stateRef.current, scene })}
              />
            )}
          </div>
          {compare && active?.image_url && (
            <div className={s.compare}>
              {doc?.map_repaint && <button aria-label="Focus changed map area" title="Focus changed map area" aria-pressed={focusMap} onClick={() => setFocusMap(v => !v)}><ScanSearch size={17} /></button>}
              <div
                className={s.comparisonImage}
                style={{
                  aspectRatio: review ? `${review.width}/${review.height}` : `${state.frame.width}/${state.frame.height}`,
                }}
              >
                { }
                <img
                  src={active.image_url}
                  alt="Generated candidate"
                  style={reviewImage}
                  onLoad={(event) => {
                    if (event.currentTarget.naturalWidth)
                      setLoadedCandidate(active.id);
                  }}
                  onError={() =>
                    setError(
                      "Candidate image could not be loaded. Reopen this drawing to retry; generation is already saved.",
                    )
                  }
                />
                {loadedCandidate !== active.id && (
                  <span className={s.previewLoading}>Loading image...</span>
                )}
                {source && (
                  <>
                    <img
                      src={source}
                      alt="Original image"
                      style={{ ...reviewImage, clipPath: `inset(0 ${100 - (review ? (review.x + split / 100 * review.width) / state.frame.width * 100 : split)}% 0 0)` }}
                    />
                    <span
                      className={s.splitLine}
                      style={{ left: `${split}%` }}
                    />
                  </>
                )}
                <span className={s.imageLabel}>
                  {source ? "Original" : "Candidate"}
                </span>
                {source && (
                  <span className={`${s.imageLabel} ${s.rightLabel}`}>
                    Candidate
                  </span>
                )}
              </div>
              {source && (
                <input
                  className={s.compareSlider}
                  type="range"
                  min="0"
                  max="100"
                  value={split}
                  aria-label="Before and after comparison"
                  onChange={(e) => setSplit(Number(e.target.value))}
                />
              )}
              <div className={s.candidateActions}>
                {active.mock && <span className={s.muted}>Mock result</span>}
                {active.workflow === "viewpoint" && (
                  <span className={s.muted}>
                    Proposed view · Geometry unverified
                  </span>
                )}
                {active.outside_changed === 0 && (
                  <span className={s.protected}>
                    <ShieldCheck size={15} />
                    Outside region unchanged
                  </span>
                )}
                {active.saved_node_id ? (
                  <>
                    <a
                      className={s.primary}
                      href={`/play?continue=${doc?.session_id}&node=${active.saved_node_id}`}
                    >
                      Open in World
                      <ArrowRight size={16} />
                    </a>
                    <button
                      disabled={busy}
                      onClick={() => {
                        window.location.href = `/sketch?source=${active.saved_node_id}`;
                      }}
                    >
                      <Pencil size={16} />
                      Edit this version
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={s.primary}
                      disabled={
                        busy ||
                        dirty ||
                        active.matches_draft === false ||
                        loadedCandidate !== active.id
                      }
                      onClick={() => void keep()}
                    >
                      <Check size={17} />
                      Keep Version
                    </button>
                    <button disabled={busy} onClick={() => setCompare(false)}>
                      <Pencil size={16} />
                      Refine drawing
                    </button>
                    <button
                      title="Discard candidate"
                      disabled={busy}
                      onClick={async () => {
                        if (!doc) return;
                        setBusy(true);
                        try {
                          await request(`/api/sketches/${doc.id}/discard`, {
                            candidate_id: active.id,
                          });
                          setCandidates((old) =>
                            old.filter((c) => c.id !== active.id),
                          );
                          setSelected(null);
                          setCompare(false);
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
              {active.matches_draft === false && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (doc)
                      void request(`/api/sketches/${doc.id}/restore`, {
                        candidate_id: active.id,
                        revision: doc.revision,
                      })
                        .then(() => load(doc.id))
                        .catch((e) => setError(e.message));
                  }}
                >
                  <RotateCcw size={15} />
                  Restore this drawing
                </button>
              )}
            </div>
          )}
          <div className={s.versions} aria-label="Version history">
            <span>Versions</span>
            {!candidates.length && (
              <span className={s.muted}>No generations yet</span>
            )}
            {candidates.map((c, i) => (
              <button
                key={c.id}
                title={`${c.model} - ${c.status}`}
                aria-label={`Version ${candidates.length - i}${c.saved_node_id ? ", kept" : ""}`}
                aria-pressed={selected === c.id}
                onClick={() => {
                  setSelected(c.id);
                  setCompare(c.status === "ready");
                }}
              >
                {c.image_url ? (
                  <img src={c.image_url} alt="" />
                ) : c.status === "running" ? (
                  <LoaderCircle size={18} />
                ) : (
                  <X size={18} />
                )}
                <span>{candidates.length - i}</span>
                {c.saved_node_id && <Check size={12} />}
              </button>
            ))}
          </div>
        </section>
        <aside
          className={`${s.panel} ${settings ? s.panelOpen : ""}`}
          aria-label="Generation settings"
        >
          <div className={s.panelTitle}>
            <h1>
              {workflow === "render"
                ? source
                  ? "Draw a correction"
                  : "From sketch to image"
                : SKETCH_WORKFLOWS[workflow]}
            </h1>
            <button
              className={s.mobileSettings}
              title="Close settings"
              onClick={() => setSettings(false)}
            >
              <X size={18} />
            </button>
          </div>
          <label className={s.label}>
            Workflow
            <select
              aria-label="Workflow"
              value={workflow}
              disabled={busy}
              onChange={(e) =>
                change({
                  ...state,
                  workflow: e.target.value as NonNullable<
                    SketchState["workflow"]
                  >,
                })
              }
            >
              {Object.entries(SKETCH_WORKFLOWS).map(([id, label]) => (
                <option
                  key={id}
                  value={id}
                  disabled={
                    !source && (id === "placement" || id === "viewpoint")
                  }
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          {workflow === "render" && !source && (
            <label className={s.label}>
              Finish as
              <select
                aria-label="Finish as"
                value={state.output ?? "auto"}
                disabled={busy}
                onChange={(e) =>
                  change({
                    ...state,
                    output: e.target.value as NonNullable<
                      SketchState["output"]
                    >,
                  })
                }
              >
                {Object.entries(SKETCH_OUTPUTS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {workflow === "material" && (
            <label className={s.label}>
              Material
              <select
                aria-label="Material"
                value={state.material ?? "custom"}
                disabled={busy}
                onChange={(e) =>
                  change({
                    ...state,
                    material: e.target.value as NonNullable<
                      SketchState["material"]
                    >,
                  })
                }
              >
                {Object.entries(SKETCH_MATERIALS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {workflow === "viewpoint" && (
            <label className={s.label}>
              Proposed view
              <select
                aria-label="Proposed view"
                value={state.viewpoint ?? "eye_level"}
                disabled={busy}
                onChange={(e) =>
                  change({
                    ...state,
                    viewpoint: e.target.value as NonNullable<
                      SketchState["viewpoint"]
                    >,
                  })
                }
              >
                {Object.entries(SKETCH_VIEWS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {workflow === "placement" && (
            <div className={s.styleReference}>
              <span>Object reference</span>
              {state.subject_data_url ? (
                <>
                  <img src={state.subject_data_url} alt="Object reference" />
                  <button
                    className={s.icon}
                    title="Remove object reference"
                    disabled={busy}
                    onClick={() =>
                      change({ ...state, subject_data_url: undefined })
                    }
                  >
                    <X size={16} />
                  </button>
                </>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => subjectInput.current?.click()}
                >
                  <ImagePlus size={15} /> Add object
                </button>
              )}
            </div>
          )}
          <label className={s.label} htmlFor="sketch-prompt">
            {source ? "Your changes" : "Your idea"}
          </label>
          <textarea
            id="sketch-prompt"
            value={state.prompt}
            maxLength={5000}
            disabled={busy}
            placeholder={
              source
                ? "A red roof. Keep the stone walls."
                : "A coastal village, ink and watercolor..."
            }
            onChange={(e) => change({ ...state, prompt: e.target.value })}
          />
          {source ? (
            <fieldset>
              <legend>Edit scope</legend>
              <div className={s.segment}>
                {(["region", "whole"] as const).map((scope) => (
                  <button
                    key={scope}
                    disabled={
                      busy || (workflow === "placement" && scope === "whole")
                    }
                    aria-pressed={state.scope === scope}
                    onClick={() => change({ ...state, scope })}
                  >
                    {scope === "region" ? <ShieldCheck size={14} /> : null}
                    {scope === "region" ? "Selected area" : "Whole image"}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : (
            <label className={s.label}>
              Canvas
              <select
                aria-label="Canvas aspect"
                disabled={busy || state.scene.elements.length > 0}
                value={`${state.frame.width}:${state.frame.height}`}
                onChange={(e) => {
                  const [width = 1024, height = 1024] = e.target.value
                    .split(":")
                    .map(Number);
                  change({ ...state, frame: { width, height } });
                  setEpoch((v) => v + 1);
                }}
              >
                <option value={`${state.frame.width}:${state.frame.height}`}>
                  {state.frame.width} x {state.frame.height}
                </option>
                {[
                  [1024, 1024, "Square"],
                  [1536, 864, "Landscape"],
                  [864, 1536, "Portrait"],
                ]
                  .filter(
                    ([w, h]) =>
                      w !== state.frame.width || h !== state.frame.height,
                  )
                  .map(([w, h, label]) => (
                    <option key={label} value={`${w}:${h}`}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className={s.label}>
            Image model
            <select
              aria-label="Image model"
              value={state.model}
              disabled={busy}
              onChange={(e) =>
                change({
                  ...state,
                  model: e.target.value as SketchState["model"],
                })
              }
            >
              {Object.entries(SKETCH_MODELS).map(([id, m]) => (
                <option key={id} value={id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className={s.styleReference}>
            <span>Style reference</span>
            {state.style_data_url ? (
              <>
                <img src={state.style_data_url} alt="Style reference" />
                <button
                  className={s.icon}
                  title="Remove style reference"
                  aria-label="Remove style reference"
                  disabled={busy}
                  onClick={() =>
                    change({ ...state, style_data_url: undefined })
                  }
                >
                  <X size={16} />
                </button>
              </>
            ) : (
              <button
                disabled={busy}
                onClick={() => styleInput.current?.click()}
              >
                <ImagePlus size={15} />
                Add image
              </button>
            )}
          </div>
          <div className={s.generateArea}>
            <div className={s.estimate}>
              <span>1 image · high quality</span>
              <span>~${SKETCH_RESERVATION.toFixed(2)} reserved</span>
            </div>
            <button
              className={s.generate}
              disabled={
                busy ||
                !ready ||
                (!source &&
                  !state.scene.elements.length &&
                  !state.prompt.trim())
              }
              onClick={() => void run()}
            >
              {busy ? (
                <LoaderCircle size={18} className={s.spin} />
              ) : (
                <Sparkles size={18} />
              )}
              {busy
                ? "Working..."
                : candidates.length
                  ? "Generate Another"
                  : "Generate"}
            </button>
          </div>
          <div className={s.exportActions}>
            <button disabled={busy} onClick={() => void exportFile("png")}>
              <Download size={15} />
              PNG
            </button>
            <button disabled={busy} onClick={() => void exportFile("scene")}>
              <Download size={15} />
              Scene
            </button>
            <button disabled={busy} onClick={() => void exportFile("bundle")}>
              <Download size={15} />
              Bundle
            </button>
          </div>
          {active?.status === "failed" && (
            <p className={s.failure}>{active.error}</p>
          )}
        </aside>
      </div>
      <input
        ref={input}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp,.json,.excalidraw,.ofb-sketch"
        onChange={(e) => {
          void importFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={subjectInput}
        hidden
        type="file"
        aria-label="Object reference file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void fileData(file)
              .then((data) =>
                change({ ...stateRef.current, subject_data_url: data }),
              )
              .catch((err) => setError(err.message));
          e.target.value = "";
        }}
      />
      <input
        ref={styleInput}
        hidden
        type="file"
        aria-label="Style reference file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void fileData(file)
              .then((data) =>
                change({ ...stateRef.current, style_data_url: data }),
              )
              .catch((err) => setError(err.message));
          e.target.value = "";
        }}
      />
      {library && (
        <div className={s.modalBackdrop}>
          <section
            className={s.library}
            role="dialog"
            aria-modal="true"
            aria-label="Saved sketches"
          >
            <header>
              <h2>Sketches</h2>
              <button
                className={s.icon}
                title="Close sketches"
                aria-label="Close sketches"
                onClick={() => setLibrary(null)}
              >
                <X size={18} />
              </button>
            </header>
            {!library.length && <p>No saved sketches yet.</p>}
            {library.map((d) => (
              <div key={d.id}>
                <button
                  onClick={() =>
                    void (async () => {
                      if (dirty) await persist();
                      await load(d.id);
                    })().catch((e) => setError(e.message))
                  }
                >
                  <Pencil size={17} />
                  <span>{d.state.title}</span>
                  <small>{new Date(d.updated_at).toLocaleDateString()}</small>
                </button>
                <button
                  className={s.icon}
                  title="Delete draft"
                  aria-label={`Delete ${d.state.title}`}
                  onClick={() => {
                    if (
                      confirm(
                        "Delete this draft? Saved world versions are kept.",
                      )
                    )
                      void request(`/api/sketches/${d.id}`, {}, "DELETE")
                        .then(() => {
                          setLibrary(
                            (old) => old?.filter((x) => x.id !== d.id) ?? null,
                          );
                          if (doc?.id === d.id) void newSketch(true);
                        })
                        .catch((e) => setError(e.message));
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </section>
        </div>
      )}
    </main>
  );
}
