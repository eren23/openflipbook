import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, Document>>(), files: new Map<string, Buffer>(), tail: Promise.resolve(), owner: true,
  stale: false, unavailable: false, failPublish: false, failQueue: false, onSubmit: null as (() => Promise<void>) | null }));
const store = (name: string) => { if (!memory.rows.has(name)) memory.rows.set(name, new Map()); return memory.rows.get(name)!; };
function matches(row: Document, query: Document): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((part: Document) => matches(row, part));
    if (key === "$and") return value.every((part: Document) => matches(row, part));
    const actual = key.split(".").reduce((part, k) => part?.[k], row);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("$in" in value) return value.$in.includes(actual);
      if ("$exists" in value) return (actual !== undefined) === value.$exists;
      if ("$lt" in value) return actual < value.$lt;
      if ("$lte" in value) return actual <= value.$lte;
      if ("$gt" in value) return actual > value.$gt;
    }
    return actual === value;
  });
}
function collection(name: string) {
  const find = (q: Document) => [...store(name).values()].filter(row => matches(row, q));
  const update = (row: Document, change: Document) => {
    if (name === "motion_assets" && memory.failPublish) throw new Error("Publication interrupted");
    if (memory.failQueue && change.$set?.status === "queued") throw new Error("Interrupted after request id");
    Object.assign(row, change.$set);
    for (const [key, value] of Object.entries(change.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value);
    for (const key of Object.keys(change.$unset ?? {})) delete row[key];
  };
  return {
    findOne: async (q: Document) => structuredClone(find(q)[0] ?? null),
    countDocuments: async (q: Document) => find(q).length,
    find: (q: Document) => { const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => structuredClone(find(q)) }; return cursor; },
    findOneAndUpdate: async (q: Document, change: Document) => { const row = find(q)[0]; if (!row) return null; update(row, change); return structuredClone(row); },
    insertOne: async (row: Document) => { if (store(name).has(row._id)) throw new Error("Duplicate"); store(name).set(row._id, structuredClone(row)); },
    updateOne: async (q: Document, change: Document, options: Document = {}) => {
      let row = find(q)[0]; if (!row && options.upsert) { row = { _id: q._id, ...change.$setOnInsert }; store(name).set(q._id, row!); }
      if (row) update(row, change); return { matchedCount: row ? 1 : 0 };
    },
    updateMany: async (q: Document, change: Document) => { for (const row of find(q)) update(row, change); },
  };
}
const db = { collection } as unknown as Db;
vi.mock("./db", () => ({ withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>) => {
  const previous = memory.tail; let release!: () => void; memory.tail = new Promise<void>(r => { release = r; }); await previous;
  const old = structuredClone(memory.rows);
  try { return await run(db, {} as ClientSession); } catch (e) { memory.rows = old; throw e; } finally { release(); }
} }));
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => { if (!memory.owner) throw new CreatorError("Not owner", 403); return db; } }));
vi.mock("./motion-source", () => ({
  currentMotionStudy: async (_db: unknown, _sid: string, _id: string, sha?: string) => {
    if (memory.stale || sha && sha !== viewHash(study)) throw new CreatorError("Stale study", 409);
    return { study, view: { session_id: "world", sources: [] } };
  },
  motionSourceImage: async () => { if (memory.unavailable) throw new CreatorError("Storage unavailable", 503); return { url: "data:image/png;base64,original", sha256: "original-sha", bytes: 12, width: 64, height: 64 }; },
}));
vi.mock("./r2", () => ({
  getStoredBytes: vi.fn(async (key: string) => memory.files.has(key) ? { bytes: memory.files.get(key)!, contentType: "video/mp4" } : null),
  uploadJpeg: vi.fn(async (key: string, bytes: Buffer) => { memory.files.set(key, bytes); return { key, url: "stored", contentType: "video/mp4" }; }),
}));
vi.mock("./motion-video", () => ({ MAX_MOTION_BYTES: 1024, silentMotionVideo: vi.fn(async () => ({ bytes: Buffer.from("silent-video"), media: { width: 64, height: 48, duration: 6, audio_streams: 0, source_audio_streams: 1, derivative: "silent_streamcopy_v1" } })) }));
import { CreatorError } from "./creator-error";
import { viewHash } from "./place-view-store";
import { H3_CAMERA_ADAPTER, H3_CAMERA_MODEL } from "./camera-motion";
import { motionJobAction, motionJobLibrary, motionVideoBytes, submitMotionJob } from "./motion-job-server";
import { processNextMotionJob } from "./motion-execution";
import { silentMotionVideo } from "./motion-video";
import { getStoredBytes } from "./r2";
import { reserveGenerationSpend } from "./generation-reservation";
import { withDbTransaction } from "./db";
import { motionStudyFixture } from "../tests/fixtures/motion-study";
import { motionComparisonPlan } from "./motion-comparison";
const study = motionStudyFixture();
const input = () => ({ action: "generate", id: "shot", confirmed: true, calibration_confirmed: true, reservation: .48, study_sha256: viewHash(study), comparison_sha256: viewHash(motionComparisonPlan(study)) });
function reviewInput() {
  const plan = motionComparisonPlan(study);
  return { action: "review", id: "motion_shot", review_id: "review", comparison_sha256: viewHash(plan), review: {
    observations: plan.frames.flatMap((frame, i) => plan.landmarks.map((landmark, j) => ({ frame: i, object_id: landmark.id, observed_seconds: frame.seconds, bounds: frame.bounds[j]! }))),
    visual: { architecture: "pass", occlusion_order: "pass", continuous_motion: "pass" }, notes: "Test fixture" } };
}
const provider = vi.fn();
const job = () => store("motion_jobs").get("world:shot")!;
const submissions = () => provider.mock.calls.filter(([url]) => String(url).endsWith("/submit"));
const total = () => [...store("spend_ledger").values()].map(row => row.total);
async function queued() { await submitMotionJob("world", "study", input()); await processNextMotionJob(db); expect(job().status).toBe("queued"); }
function ready() { job().next_check = new Date(0); provider.mockImplementation(async (url: string) => url.includes("/requests/")
  ? Response.json({ status: "ready", video: { url: "https://fal.media/clip.mp4" }, expanded_prompt: "Saved expansion" }) : new Response("original-video")); }
beforeEach(() => {
  memory.rows.clear(); memory.files.clear(); memory.owner = true; memory.stale = false; memory.unavailable = false; memory.failPublish = false; memory.failQueue = false; memory.onSubmit = null; memory.tail = Promise.resolve();
  vi.clearAllMocks(); vi.stubGlobal("fetch", provider);
  vi.stubEnv("MODAL_API_URL", "https://backend.test"); vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES", "1"); vi.stubEnv("WORLD_SCENES", "1");
  vi.stubEnv("MAX_DAILY_SPEND", "0"); vi.stubEnv("MAX_SESSION_SPEND", "0"); vi.stubEnv("MOTION_DAILY_CAP_USD", "3");
  store("motion_studies").set("world:study", structuredClone(study));
  store("generation_workers").set("worker", { _id: "worker", kind: "place-layout", motion_v1: true, motion_review_v1: true, last_seen: new Date() });
  provider.mockImplementation(async (url: string) => {
    if (url.endsWith("/capabilities")) return Response.json({ enabled: true, model: H3_CAMERA_MODEL, adapter: H3_CAMERA_ADAPTER, purpose: "calibration", resolution: "768P", reservation_usd_per_second: .08 });
    if (url.endsWith("/submit")) { await memory.onSubmit?.(); return Response.json({ request_id: "provider-request", model: H3_CAMERA_MODEL }); }
    return Response.json({ status: "running" });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("reserves once for concurrent identical requests, without immediate provider submission", async () => {
  const result = await Promise.all([submitMotionJob("world", "study", input()), submitMotionJob("world", "study", input())]);
  expect(result[0]).toEqual(result[1]); expect(store("motion_jobs").size).toBe(1); expect(total()).toEqual([.48, .48, .48]); expect(submissions()).toHaveLength(0);
  memory.stale = true;
  await expect(submitMotionJob("world", "study", input())).resolves.toEqual(result[0]);
  await expect(submitMotionJob("world", "study", { ...input(), reservation: .49 })).rejects.toMatchObject({ status: 409 });
});
it.each(["consent", "calibration", "price", "worker", "source", "storage"])("rejects invalid %s before reserving", async kind => {
  const request = input();
  if (kind === "consent") request.confirmed = false;
  if (kind === "calibration") request.calibration_confirmed = false;
  if (kind === "price") request.reservation = .12;
  if (kind === "worker") store("generation_workers").clear();
  if (kind === "source") memory.stale = true;
  if (kind === "storage") memory.unavailable = true;
  await expect(submitMotionJob("world", "study", request)).rejects.toBeInstanceOf(Error);
  expect(total()).toEqual([]); expect(submissions()).toHaveLength(0);
});
it("competes with other assets in the shared daily budget", async () => {
  vi.stubEnv("MAX_DAILY_SPEND", ".5");
  const results = await Promise.allSettled([submitMotionJob("world", "study", input()), withDbTransaction((db, s) => reserveGenerationSpend(db, s, "world", "mesh", .2, "MESH_DAILY_CAP_USD"))]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
});
it("defaults to a three-dollar motion cap without requiring an environment override", async () => {
  vi.stubEnv("MOTION_DAILY_CAP_USD", undefined);
  for (let i = 0; i < 6; i++) await submitMotionJob("world", "study", { ...input(), id: `shot${i}` });
  await expect(submitMotionJob("world", "study", { ...input(), id: "over-budget" })).rejects.toMatchObject({ status: 429 });
  expect(store("motion_jobs").size).toBe(6); expect(submissions()).toHaveLength(0);
  for (const value of total()) expect(value).toBeCloseTo(2.88);
});
it("rejects cross-owner reads, writes, cancellation and replay before provider access", async () => {
  memory.owner = false;
  for (const run of [() => submitMotionJob("world", "study", input()), () => motionJobLibrary("world", "study"),
    () => motionJobAction("world", "study", { action: "cancel", id: "shot" }), () => motionVideoBytes("world", "study", "motion_shot")])
    await expect(run()).rejects.toMatchObject({ status: 403 });
  expect(provider).not.toHaveBeenCalled(); expect(getStoredBytes).not.toHaveBeenCalled();
});
it("claims once under concurrent workers and sends the frozen source and parameters", async () => {
  await submitMotionJob("world", "study", input()); await Promise.all([processNextMotionJob(db), processNextMotionJob(db)]);
  expect(submissions()).toHaveLength(1); expect(job().request_id).toBe("provider-request");
  const body = JSON.parse(submissions()[0]![1].body);
  expect(body).toMatchObject({ model: H3_CAMERA_MODEL, adapter: H3_CAMERA_ADAPTER, purpose: "calibration", reservation: .48, parameters: study.preparation.parameters,
    source: { url: "data:image/png;base64,original", sha256: "original-sha" } });
});
it("cancels stale unsubmitted sources and refunds once", async () => {
  await submitMotionJob("world", "study", input()); memory.stale = true;
  await processNextMotionJob(db); await processNextMotionJob(db);
  expect(job().status).toBe("cancelled"); expect(total()).toEqual([0, 0, 0]); expect(submissions()).toHaveLength(0);
});
it.each(["model", "adapter", "preparation_sha256", "parameters"])("rejects changed queued %s before submission and refunds once", async field => {
  await submitMotionJob("world", "study", input());
  job()[field] = field === "parameters" ? { ...job().parameters, duration: 12 } : "changed";
  await processNextMotionJob(db); await processNextMotionJob(db);
  expect(job().status).toBe("cancelled"); expect(total()).toEqual([0, 0, 0]); expect(submissions()).toHaveLength(0);
});
it("keeps unavailable input unsubmitted and cancellable", async () => {
  await submitMotionJob("world", "study", input()); memory.unavailable = true;
  await processNextMotionJob(db); expect(job().status).toBe("scheduled"); expect(submissions()).toHaveLength(0);
  await motionJobAction("world", "study", { action: "cancel", id: "shot" }); await motionJobAction("world", "study", { action: "cancel", id: "shot" });
  expect(total()).toEqual([0, 0, 0]);
});
it("retains ambiguity after a lost response without resubmitting", async () => {
  await submitMotionJob("world", "study", input()); provider.mockRejectedValue(new Error("Lost response"));
  await processNextMotionJob(db); await processNextMotionJob(db);
  expect(job().status).toBe("submission_unknown"); expect(submissions()).toHaveLength(1); expect(total()).toEqual([.48, .48, .48]);
});
it("retains a late request id after cancellation without reviving the job or refunding", async () => {
  await submitMotionJob("world", "study", input()); memory.onSubmit = () => motionJobAction("world", "study", { action: "cancel", id: "shot" }).then(() => {});
  await processNextMotionJob(db); expect(job()).toMatchObject({ status: "cancelled", request_id: "provider-request" }); expect(total()).toEqual([.48, .48, .48]);
});
it("recovers an ID saved before the queued-state write failed", async () => {
  await submitMotionJob("world", "study", input()); memory.failQueue = true; await processNextMotionJob(db);
  expect(job()).toMatchObject({ status: "submission_unknown", request_id: "provider-request" });
  memory.failQueue = false; ready(); await processNextMotionJob(db); expect(job().status).toBe("ready");
});
it("stores original and verified-silent bytes, accepts explicitly and replays historical output for free", async () => {
  await queued(); ready(); await processNextMotionJob(db);
  expect(job().status).toBe("ready"); expect(store("motion_selections").size).toBe(0);
  const asset = store("motion_assets").get("world:motion_shot")!;
  expect(memory.files.get(asset.original.key)?.toString()).toBe("original-video"); expect(memory.files.get(asset.silent.key)?.toString()).toBe("silent-video");
  expect(asset).toMatchObject({ study_id: "study", study_sha256: viewHash(study), expanded_prompt: "Saved expansion", media: { audio_streams: 0 } });
  await motionJobAction("world", "study", reviewInput());
  await motionJobAction("world", "study", { action: "accept", id: "motion_shot", previous_id: null, review_id: "review" });
  expect(store("motion_selections").get("world:study")!.asset_id).toBe("motion_shot");
  memory.stale = true; provider.mockClear();
  expect((await motionJobLibrary("world", "study")).assets[0]!.historical).toBe(true);
  expect((await motionVideoBytes("world", "study", "motion_shot")).toString()).toBe("silent-video");
  await expect(motionJobAction("world", "study", { action: "accept", id: "motion_shot", previous_id: null, review_id: "review" })).rejects.toMatchObject({ status: 409 });
  expect(provider).not.toHaveBeenCalled();
});
it("retries publication from stored bytes without another provider call", async () => {
  await queued(); ready(); memory.failPublish = true; await processNextMotionJob(db);
  expect(job().status).toBe("storage_failed"); expect(store("motion_assets").size).toBe(0);
  memory.failPublish = false; provider.mockClear(); vi.mocked(silentMotionVideo).mockClear();
  await motionJobAction("world", "study", { action: "retry_storage", id: "shot" }); await processNextMotionJob(db);
  expect(job().status).toBe("ready"); expect(provider).not.toHaveBeenCalled(); expect(silentMotionVideo).not.toHaveBeenCalled();
});
it("preserves original video on decode failure and fails corrupt replay without regeneration", async () => {
  await queued(); ready(); vi.mocked(silentMotionVideo).mockRejectedValueOnce(new Error("Corrupt video")); await processNextMotionJob(db);
  expect(job().status).toBe("storage_failed"); expect(memory.files.get(job().original.key)?.toString()).toBe("original-video");
  await motionJobAction("world", "study", { action: "retry_storage", id: "shot" }); await processNextMotionJob(db);
  const asset = store("motion_assets").get("world:motion_shot")!; memory.files.set(asset.silent.key, Buffer.from("corrupt")); provider.mockClear();
  await expect(motionVideoBytes("world", "study", "motion_shot")).rejects.toMatchObject({ status: 503 }); expect(provider).not.toHaveBeenCalled();
});
it("requires the quoted comparison contract and a compatible worker before reserving", async () => {
  await expect(submitMotionJob("world", "study", { ...input(), comparison_sha256: "old" })).rejects.toMatchObject({ status: 409 });
  delete store("generation_workers").get("worker")!.motion_review_v1;
  await expect(submitMotionJob("world", "study", input())).rejects.toMatchObject({ status: 503 });
  expect(total()).toEqual([]);
});
it("rejects changed queued criteria before paid submission", async () => {
  await submitMotionJob("world", "study", input()); job().comparison.plan.tolerances.position = 1;
  await processNextMotionJob(db); expect(job().status).toBe("cancelled"); expect(total()).toEqual([0, 0, 0]); expect(submissions()).toHaveLength(0);
});
it("stores failed historical reviews and idempotent retries without accepting or submitting", async () => {
  await queued(); ready(); await processNextMotionJob(db); memory.stale = true; provider.mockClear();
  const input = reviewInput(); input.review.visual.architecture = "fail";
  const result = await motionJobAction("world", "study", input);
  expect(result).toMatchObject({ outcome: { status: "fail" } });
  await expect(motionJobAction("world", "study", input)).resolves.toEqual(result);
  expect(store("motion_reviews").size).toBe(1); expect(store("motion_selections").size).toBe(0); expect(provider).not.toHaveBeenCalled();
  input.review.notes = "Changed";
  await expect(motionJobAction("world", "study", input)).rejects.toMatchObject({ status: 409 });
});
it("recomputes acceptance from bound measurements instead of trusting a stored pass label", async () => {
  await queued(); ready(); await processNextMotionJob(db);
  await expect(motionJobAction("world", "study", { action: "accept", id: "motion_shot", previous_id: null })).rejects.toMatchObject({ status: 409 });
  const input = reviewInput(); input.review.observations.pop();
  await motionJobAction("world", "study", input); store("motion_reviews").get("world:review")!.outcome.status = "pass";
  await expect(motionJobAction("world", "study", { action: "accept", id: "motion_shot", previous_id: null, review_id: "review" })).rejects.toMatchObject({ status: 409 });
  expect(store("motion_selections").size).toBe(0);
});
it("refuses a path beyond the measured H3 limits before quoting or reserving", async () => {
  // A 45° orbit: camera-motion.ts lists it as a limit issue and the backend
  // would 422 it after the spend was reserved.
  const saved = structuredClone(study.preparation);
  try {
    study.preparation.parameters.camera_trajectory[1]!.azimuth = 45;
    (study.preparation as { limit_issues?: string[] }).limit_issues = ["H3 camera controls are measured only up to 30° of turn per clip"];
    store("motion_studies").set("world:study", structuredClone(study));
    const library = await motionJobLibrary("world", "study");
    expect(library.quote).toBeNull(); expect(library.reason).toMatch(/30° of turn/);
    await expect(submitMotionJob("world", "study", input())).rejects.toMatchObject({ status: 409 });
    expect(total()).toEqual([]); expect(store("motion_jobs").size).toBe(0); expect(submissions()).toHaveLength(0);
  } finally { study.preparation = saved; }
});
