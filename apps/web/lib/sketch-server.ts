import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { getDb, getNode, insertNode, withDbTransaction } from "./db";
import { requireOwner } from "./session-owner";
import {
  CreatorError,
  requireCreator,
  creatorJson,
  checkCreatorWrite,
} from "./creator";
import { getStoredBytes, uploadJpeg, decodeDataUrl } from "./r2";
import { isSafeId } from "./ids";
import {
  blankSketch,
  parseSketch,
  rasterDataUrl,
  sketchWorkflowError,
  SKETCH_MODELS,
  SKETCH_RESERVATION,
  type SketchState,
  type SketchDocument,
  type SketchCandidate,
} from "./sketch-types";
import { modalAuthHeaders, modalUrl } from "./modal";
import { sseData } from "./sse";
import { mapRepaintState, parseMapRegistration, type MapRepaintBinding } from "./map-artwork";
import { assertMapRepaintCurrent, artworkHeadKey, mapArtworkContext, type MapArtworkHead, type MapArtworkVersion } from "./map-artwork-server";

interface Draft {
  map_repaint?: MapRepaintBinding;
  _id: string;
  session_id: string;
  revision: number;
  state: SketchState;
  source_node_id: string | null;
  source_key: string | null;
  updated_at: Date;
}
interface Run {
  discarded?: boolean;
  mock?: boolean;
  _id: string;
  draft_id: string;
  session_id: string;
  revision: number;
  snapshot: Draft;
  status: SketchCandidate["status"];
  model: string;
  created_at: Date;
  output_key?: string;
  saved_node_id?: string;
  error?: string;
  outside_changed?: number | undefined;
  guide_key?: string;
  mask_key?: string | undefined;
  reservation: number;
}
export function sketchEnabled() {
  return (
    process.env.NEXT_PUBLIC_SKETCH_ENABLED === "1" ||
    (process.env.NODE_ENV !== "production" &&
      process.env.NEXT_PUBLIC_SKETCH_ENABLED !== "0")
  );
}
function enabled() {
  if (!sketchEnabled()) throw new CreatorError("Sketch is not enabled", 404);
}
function stateInput(value: unknown) {
  try {
    return parseSketch(value);
  } catch (error) {
    throw new CreatorError((error as Error).message, 400);
  }
}
async function bodyInput(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (Buffer.byteLength(text) > 24 * 1024 * 1024)
    throw new CreatorError("Sketch upload exceeds 24 MiB", 413);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CreatorError("Invalid JSON", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CreatorError("Invalid sketch request", 400);
  return value;
}
function url(key: string | null | undefined) {
  return key
    ? `${process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "")}/${key}`
    : null;
}
const wire = (d: Draft): SketchDocument => ({
  ...(d.map_repaint ? { map_repaint: d.map_repaint } : {}),
  id: d._id,
  session_id: d.session_id,
  revision: d.revision,
  state: parseSketch(d.state),
  source_node_id: d.source_node_id,
  source_url: url(d.source_key),
  updated_at: d.updated_at.toISOString(),
});
function sameDrawing(a: Draft, b: Draft) {
  return (
    a.source_key === b.source_key &&
    a.source_node_id === b.source_node_id &&
    JSON.stringify(parseSketch(a.state)) ===
      JSON.stringify(parseSketch(b.state))
  );
}
const candidate = (r: Run, d: Draft): SketchCandidate => ({
  workflow: r.snapshot.state.workflow ?? "render",
  mock: r.mock ?? false,
  id: r._id,
  draft_id: r.draft_id,
  revision: r.revision,
  status: r.status,
  model: r.model,
  created_at: r.created_at.toISOString(),
  ...(r.output_key ? { image_url: url(r.output_key)! } : {}),
  ...(r.saved_node_id ? { saved_node_id: r.saved_node_id } : {}),
  ...(r.error ? { error: r.error } : {}),
  outside_changed: r.outside_changed,
  reservation: r.reservation,
  matches_draft: sameDrawing(r.snapshot, d),
});
async function drafts() {
  return (await getDb()).collection<Draft>("sketches");
}
async function runs() {
  return (await getDb()).collection<Run>("sketch_runs");
}
async function owned(id: string) {
  enabled();
  if (!isSafeId(id)) throw new CreatorError("Invalid sketch id", 400);
  const d = await (await drafts()).findOne({ _id: id });
  if (!d) throw new CreatorError("Sketch not found", 404);
  await requireCreator(d.session_id);
  return d;
}
async function upload(data: unknown, sessionId: string, label: string) {
  if (!rasterDataUrl(data))
    throw new CreatorError(`Invalid ${label} image`, 400);
  const decoded = decodeDataUrl(data);
  const ext = decoded.contentType.split("/")[1];
  return (
    await uploadJpeg(
      `${sessionId}/sketch/${crypto.randomUUID()}.${ext}`,
      decoded.bytes,
      decoded.contentType,
    )
  ).key;
}
export async function createSketch(req: Request) {
  enabled();
  checkCreatorWrite(req);
  const body = await bodyInput(req);
  const state = body.state ? stateInput(body.state) : blankSketch();
  let sessionId = crypto.randomUUID();
  let sourceKey: string | null = null;
  let sourceNode: string | null = null;
  if (body.source_node_id) {
    if (!isSafeId(body.source_node_id))
      throw new CreatorError("Invalid source", 400);
    const node = await getNode(body.source_node_id);
    if (!node) throw new CreatorError("Source not found", 404);
    await requireCreator(node.session_id);
    sessionId = node.session_id;
    sourceKey = node.image_key;
    sourceNode = node.id;
  }
  const auth = await requireOwner(sessionId);
  if (!auth.ok) return auth.res;
  if (!sourceNode && body.source_data_url)
    sourceKey = await upload(body.source_data_url, sessionId, "source");
  const d: Draft = {
    _id: crypto.randomUUID(),
    session_id: sessionId,
    source_node_id: sourceNode,
    source_key: sourceKey,
    revision: 1,
    state,
    updated_at: new Date(),
  };
  await (await drafts()).insertOne(d);
  return creatorJson({ sketch: wire(d), candidates: [] });
}
export async function createMapArtworkSketch(req: Request, sid: string, pid: string) {
  enabled(); checkCreatorWrite(req);
  const body = await bodyInput(req), context = await mapArtworkContext(sid, pid);
  if (!context.scene.source_node_id) throw new CreatorError("This place has no saved parent map", 409);
  if (body.scene_revision !== context.scene.revision || body.map_source_node_id !== context.map.id) throw new CreatorError("World or map changed. Reload before preparing the repaint.", 409);
  if (body.confirmed !== true) throw new CreatorError("Review the map placement first", 400);
  let state: SketchState, registration: ReturnType<typeof parseMapRegistration>;
  try {
    registration = parseMapRegistration(body.registration);
    if (context.registration && (["x", "y", "width", "rotation"] as const).some(key => registration[key] !== context.registration![key])) throw new Error("Map placement is fixed by accepted artwork. Reuse the saved placement.");
    state = mapRepaintState(context.baseline.definition, context.scene.definition, registration, body.frame as { width: number; height: number }, context.scene.revision);
  } catch (e) { throw new CreatorError((e as Error).message, 400); }
  const node = await getNode(context.map.id);
  if (!node || node.session_id !== sid) throw new CreatorError("Map source is unavailable", 409);
  const draft: Draft = { _id: crypto.randomUUID(), session_id: sid, revision: 1, state, source_node_id: node.id, source_key: node.image_key, updated_at: new Date(), map_repaint: {
    scene_id: context.scene.id, scene_revision: context.scene.revision, scene_source_node_id: context.scene.source_node_id, place_id: pid,
    map_root_node_id: context.map.root_id, base_map_node_id: context.map.id, baseline_revision: context.baseline.revision, registration,
  } };
  await (await drafts()).insertOne(draft);
  return { sketch: wire(draft), candidates: [] };
}
export async function listSketches() {
  enabled();
  const db = await getDb();
  const token = (await cookies()).get("ofb_owner")?.value;
  if (!token) return { sketches: [] };
  const owners = await db
    .collection<{ _id: string; owner_token: string }>("session_owners")
    .find({ owner_token: token })
    .project<{ _id: string }>({ _id: 1 })
    .toArray();
  const result = await (
    await drafts()
  )
    .find({ session_id: { $in: owners.map((o) => o._id) } })
    .sort({ updated_at: -1 })
    .limit(50)
    .toArray();
  return {
    sketches: result.map((d) => ({
      ...wire(d),
      state: {
        ...d.state,
        scene: { elements: [], files: {} },
        style_data_url: undefined,
        subject_data_url: undefined,
      },
    })),
  };
}
export async function readSketch(id: string) {
  const d = await owned(id);
  const result = await (
    await runs()
  )
    .find({ draft_id: id, discarded: { $ne: true } })
    .sort({ created_at: -1 })
    .limit(30)
    .toArray();
  return { sketch: wire(d), candidates: result.map((r) => candidate(r, d)) };
}
export async function sketchSource(id: string) {
  const d = await owned(id);
  const source = d.source_key ? await getStoredBytes(d.source_key) : null;
  if (!source) throw new CreatorError("Source not found", 404);
  return new Response(new Uint8Array(source.bytes), {
    headers: {
      "Content-Type": source.contentType,
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
}
export async function saveSketch(id: string, req: Request) {
  checkCreatorWrite(req);
  const d = await owned(id);
  const body = await bodyInput(req);
  const state = stateInput(body.state);
  if (body.revision !== d.revision)
    throw new CreatorError(
      "Sketch changed in another tab. Reload before saving.",
      409,
    );
  if (
    d.source_key &&
    (state.frame.width !== d.state.frame.width ||
      state.frame.height !== d.state.frame.height)
  )
    throw new CreatorError("Source dimensions cannot change", 400);
  const next = {
    ...d,
    state,
    revision: d.revision + 1,
    updated_at: new Date(),
  };
  const result = await (
    await drafts()
  ).replaceOne({ _id: id, revision: d.revision }, next);
  if (!result.matchedCount)
    throw new CreatorError(
      "Sketch changed in another tab. Reload before saving.",
      409,
    );
  return { sketch: wire(next) };
}
export async function deleteSketch(id: string) {
  await owned(id);
  await (await drafts()).deleteOne({ _id: id });
  return { deleted: true };
}
async function reserve(sessionId: string) {
  await withDbTransaction(async (db, session) => {
    const col = db.collection<{ _id: string; total: number; updated_at: Date }>(
      "spend_ledger",
    );
    const day = new Date().toISOString().slice(0, 10);
    for (const [id, cap] of [
      [`day:${day}`, Number(process.env.MAX_DAILY_SPEND) || 0],
      [`sess:${sessionId}:${day}`, Number(process.env.MAX_SESSION_SPEND) || 0],
    ] as const) {
      const old = await col.findOne({ _id: id }, { session });
      if (cap > 0 && (old?.total ?? 0) + SKETCH_RESERVATION > cap)
        throw new CreatorError("Spend cap reached", 429);
      await col.updateOne(
        { _id: id },
        {
          $inc: { total: SKETCH_RESERVATION },
          $set: { updated_at: new Date() },
        },
        { upsert: true, session },
      );
    }
  });
}
export async function generateSketch(
  req: Request,
  body: {
    sketch_id?: string;
    sketch_revision?: number;
    sketch_exports?: { guide: string; mask?: string };
  },
) {
  checkCreatorWrite(req);
  const d = await owned(body.sketch_id ?? "");
  if (d.map_repaint) {
    if (d.state.scope !== "region" || d.state.workflow !== "render") throw new CreatorError("Map repaint requires protected-region artwork editing", 400);
    await assertMapRepaintCurrent(d.session_id, d.map_repaint);
  }
  if (body.sketch_revision !== d.revision)
    throw new CreatorError("Save the current drawing before generating", 409);
  const workflowError = sketchWorkflowError(d.state, Boolean(d.source_key));
  if (workflowError) throw new CreatorError(workflowError, 400);
  const exp = body.sketch_exports;
  if (
    !exp ||
    !rasterDataUrl(exp.guide) ||
    (d.source_key && d.state.scope === "region" && !rasterDataUrl(exp.mask))
  )
    throw new CreatorError(
      "A valid drawing and selected region are required",
      400,
    );
  const key = req.headers.get("idempotency-key");
  if (!key || key.length > 128)
    throw new CreatorError("Generation request id required", 400);
  const id = createHash("sha256").update(`${d._id}:${key}`).digest("hex");
  const col = await runs();
  const previous = await col.findOne({ _id: id });
  if (previous)
    return creatorJson(
      { candidate: candidate(previous, d) },
      previous.status === "running" ? 202 : 200,
    );
  const run: Run = {
    _id: id,
    draft_id: d._id,
    session_id: d.session_id,
    revision: d.revision,
    snapshot: d,
    status: "running",
    model: SKETCH_MODELS[d.state.model].endpoint,
    created_at: new Date(),
    reservation: SKETCH_RESERVATION,
  };
  try {
    await col.insertOne(run);
  } catch (e) {
    if ((e as { code?: number }).code === 11000)
      return creatorJson({ error: "Generation already started" }, 409);
    throw e;
  }
  try {
    const backend = process.env.MODAL_API_URL;
    if (!backend) throw new Error("Image backend is not configured");
    const source = d.source_key ? await getStoredBytes(d.source_key) : null;
    if (d.source_key && !source)
      throw new Error("Source image could not be loaded");
    run.guide_key = await upload(exp.guide, d.session_id, "drawing");
    if (exp.mask && d.source_key && d.state.scope === "region")
      run.mask_key = await upload(exp.mask, d.session_id, "mask");
    await col.updateOne(
      { _id: id },
      { $set: { guide_key: run.guide_key, mask_key: run.mask_key } },
    );
    await reserve(d.session_id);
    const response = await fetch(modalUrl(backend, "/sse/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...modalAuthHeaders() },
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(750_000)]),
      body: JSON.stringify({
        mode: "edit",
        query: d.state.prompt || "Create an image from the drawing",
        session_id: d.session_id,
        current_node_id: d.source_node_id ?? "",
        web_search: false,
        image_model: run.model,
        image: source
          ? `data:${source.contentType};base64,${source.bytes.toString("base64")}`
          : undefined,
        sketch_input: {
          guide: exp.guide,
          mask: run.mask_key ? exp.mask : undefined,
          width: d.state.frame.width,
          height: d.state.frame.height,
          kind: source ? "edit" : "create",
          scope: d.state.scope,
          focus_region: Boolean(d.map_repaint),
          style: d.state.style_data_url,
          workflow: d.state.workflow ?? "render",
          output: d.state.output ?? "auto",
          material: d.state.material ?? "custom",
          viewpoint: d.state.viewpoint ?? "eye_level",
          subject:
            d.state.workflow === "placement"
              ? d.state.subject_data_url
              : undefined,
        },
        verify: false,
        max_attempts: 1,
      }),
    });
    if (!response.ok || !response.body)
      throw new Error(`Image backend returned ${response.status}`);
    let final:
      | { image_data_url: string; outside_changed?: number; mock?: boolean }
      | undefined;
    for await (const payload of sseData(response.body)) {
      const event = JSON.parse(payload);
      if (event.type === "error")
        throw new Error(event.message || "Image generation failed");
      if (event.type === "final") final = event;
    }
    if (!final) throw new Error("Image generation ended without a result");
    run.output_key = await upload(
      final.image_data_url,
      d.session_id,
      "candidate",
    );
    run.outside_changed = final.outside_changed;
    run.mock = final.mock ?? false;
    run.status = "ready";
    await col.updateOne(
      { _id: id },
      {
        $set: {
          status: run.status,
          output_key: run.output_key,
          outside_changed: run.outside_changed,
          mock: run.mock,
        },
      },
    );
    return creatorJson({ candidate: candidate(run, await owned(d._id)) });
  } catch (e) {
    run.status = "failed";
    run.error = (e as Error).message.slice(0, 300);
    await col.updateOne(
      { _id: id },
      { $set: { status: run.status, error: run.error } },
    );
    return creatorJson({ candidate: candidate(run, d), error: run.error }, 502);
  }
}
export async function acceptSketch(id: string, req: Request) {
  checkCreatorWrite(req);
  const d = await owned(id);
  const body = await bodyInput(req);
  if (!isSafeId(body.candidate_id))
    throw new CreatorError("Invalid candidate id", 400);
  const run = await (
    await runs()
  ).findOne({
    _id: body.candidate_id,
    draft_id: id,
    status: "ready",
    discarded: { $ne: true },
  });
  if (!run?.output_key) throw new CreatorError("Candidate not found", 404);
  if (run.saved_node_id) return { node_id: run.saved_node_id };
  if (d.map_repaint && (run.mock || run.outside_changed !== 0)) throw new CreatorError("A real result with unchanged protected pixels is required", 409);
  if (!sameDrawing(run.snapshot, d) || body.revision !== d.revision)
    throw new CreatorError(
      "This result belongs to an earlier drawing. Restore its drawing before keeping it.",
      409,
    );
  // Deterministic node id makes acceptance retryable even after a lost response.
  const nodeId = `sketch-${run._id}`;
  await withDbTransaction(async (db, session) => {
    const claimed = await db
      .collection<Draft>("sketches")
      .updateOne(
        { _id: id, revision: d.revision },
        { $set: { updated_at: new Date() } },
        { session },
      );
    if (!claimed.matchedCount)
      throw new CreatorError("Drawing changed before acceptance", 409);
    const fresh = await db
      .collection<Run>("sketch_runs")
      .findOne({ _id: run._id }, { session });
    if (fresh?.saved_node_id) return;
    if (d.map_repaint) {
      const scene = await assertMapRepaintCurrent(d.session_id, d.map_repaint, db, session);
      // Write the geometry row too: concurrent scene edits must conflict with artwork acceptance.
      await db.collection("place_scenes").updateOne({ _id: scene._id as never, revision: scene.revision }, { $set: { artwork_checked_at: new Date() } }, { session });
    }
    if (
      d.source_node_id &&
      !(await db
        .collection("nodes")
        .findOne(
          { _id: d.source_node_id as never, session_id: d.session_id },
          { session },
        ))
    )
      throw new CreatorError("Original world node is no longer available", 409);
    await insertNode(
      {
        id: nodeId,
        session_id: d.session_id,
        parent_id: d.source_node_id,
        query: d.state.title || "Sketch",
        page_title: d.state.title || "Sketch",
        image_key: run.output_key!,
        image_model: run.model,
        prompt_author_model: "sketch",
        aspect_ratio: `${d.state.frame.width}:${d.state.frame.height}`,
        final_prompt: null,
        relation: d.source_node_id ? "edit" : "descend",
        scale: "peer",
        scene_view: null,
      },
      session,
    );
    await db
      .collection<Run>("sketch_runs")
      .updateOne(
        { _id: run._id },
        { $set: { saved_node_id: nodeId } },
        { session },
      );
    if (d.map_repaint) {
      await db.collection<MapArtworkVersion>("map_artwork_versions").insertOne({ _id: nodeId, node_id: nodeId, session_id: d.session_id, ...d.map_repaint, created_at: new Date() }, { session });
      await db.collection<MapArtworkHead>("map_artwork_heads").updateOne({ _id: artworkHeadKey(d.session_id, d.map_repaint.map_root_node_id) }, { $set: { node_id: nodeId, session_id: d.session_id, map_root_node_id: d.map_repaint.map_root_node_id } }, { session, upsert: true });
    }
  });
  return { node_id: nodeId };
}
export async function discardSketchCandidate(id: string, req: Request) {
  checkCreatorWrite(req);
  await owned(id);
  const body = await bodyInput(req);
  if (!isSafeId(body.candidate_id))
    throw new CreatorError("Invalid candidate id", 400);
  const result = await (
    await runs()
  ).updateOne(
    {
      _id: body.candidate_id,
      draft_id: id,
      status: { $ne: "running" },
      saved_node_id: { $exists: false },
    },
    { $set: { discarded: true } },
  );
  if (!result.matchedCount)
    throw new CreatorError(
      "Only unsaved, finished candidates can be discarded",
      409,
    );
  return { discarded: true };
}
export async function restoreSketch(id: string, req: Request) {
  checkCreatorWrite(req);
  const d = await owned(id);
  const body = await bodyInput(req);
  if (!isSafeId(body.candidate_id))
    throw new CreatorError("Invalid candidate id", 400);
  const run = await (
    await runs()
  ).findOne({ _id: body.candidate_id, draft_id: id });
  if (!run || body.revision !== d.revision)
    throw new CreatorError("Drawing changed. Reload before restoring.", 409);
  // Revision numbers remain monotonic even when restoring old content.
  const result = await (
    await drafts()
  ).replaceOne(
    { _id: id, revision: d.revision },
    { ...run.snapshot, revision: d.revision + 1, updated_at: new Date() },
  );
  if (!result.matchedCount)
    throw new CreatorError("Drawing changed in another tab", 409);
  return readSketch(id);
}
