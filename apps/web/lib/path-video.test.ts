import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ClientSession, Db, Document } from "mongodb";
import { PerspectiveCamera, Vector3 } from "three";
const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, Document>>(), files: new Map<string, Buffer>(), tail: Promise.resolve(),
  owner: true, stale: false, painted: 0, landings: [] as number[], keyframes: true, statusDown: false, onSubmit: null as (() => Promise<Response | void>) | null, historical: [] as string[], legFloor: 3 as number | null }));
const store = (name: string) => { if (!memory.rows.has(name)) memory.rows.set(name, new Map()); return memory.rows.get(name)!; };
function matches(row: Document, query: Document): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((part: Document) => matches(row, part));
    if (key === "$and") return value.every((part: Document) => matches(row, part));
    const actual = key.split(".").reduce((part, k) => part?.[k], row);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("$in" in value) return value.$in.includes(actual);
      if ("$ne" in value) return actual !== value.$ne;
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
    Object.assign(row, structuredClone(change.$set));
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
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => { if (!memory.owner) throw new CreatorError("Not the owner", 403); return db; } }));
vi.mock("./motion-source", async original => ({ ...(await original<object>()),
  currentMotionStudy: async (_db: unknown, _sid: string, _id: string, sha?: string) => {
    const study = store("motion_studies").get("world:study")!;
    if (memory.stale || sha && sha !== viewHash(study)) throw new CreatorError("Stale study", 409);
    return { study: structuredClone(study), view: { session_id: "world", sources: [] } };
  },
}));
vi.mock("./r2", () => ({
  getStoredBytes: vi.fn(async (key: string) => memory.files.has(key) ? { bytes: memory.files.get(key)!, contentType: "application/octet-stream" } : null),
  uploadJpeg: vi.fn(async (key: string, bytes: Buffer) => { memory.files.set(key, bytes); return { key, url: "stored", contentType: "video/mp4" }; }),
}));
vi.mock("./illustration-input", async original => ({ ...(await original<object>()), keyframeArt: vi.fn(async () => null) }));
// Saved views are current unless listed; their geometry names the gated building.
vi.mock("./place-view-store", async original => ({ ...(await original<object>()),
  assertCurrentView: vi.fn(async (_db: unknown, view: { id: string }) => {
    if (memory.historical.includes(view.id)) throw new CreatorError("View sources changed. Capture the saved scene again.", 409);
    return [{ definition: { objects: [{ id: "target", label: "Copper Kettle", kind: "building" }] } }];
  }),
}));
vi.mock("./illustration-keyframe-server", () => ({
  prepareKeyframeInput: vi.fn(async (_passes: unknown, _sources: unknown, _art: unknown, chain?: unknown) => ({ inputs: { image_url: "data:image/png;base64,AA==", keyframe_stage: chain ? "chain" : "first" }, gate_object_id: "target" })),
  keyframeGateBody: vi.fn(async (_passes: unknown, id: string | null, urls: string[]) => id ? { image_urls: urls, box: [0, 0, 8, 8], width: 64, height: 32, label: "building" } : null),
  finishKeyframe: vi.fn(async (_passes: unknown, _id: unknown, _urls: unknown, _masks: unknown, chain: unknown) => paintedReceipt(chain)),
}));
// The grey level each keyframe reduces to, and the level each leg's cut frame lands on.
// The source image reduces to 0.
const grey: Record<string, number> = { "kf-1": 100, "kf-2": 200 };
vi.mock("./motion-video", async original => ({ ...(await original<object>()),
  grayFrame: vi.fn(async (bytes: Buffer) => new Uint8Array(2304).fill(grey[bytes.toString()] ?? 0)),
  legMotion: vi.fn(async () => { const level = memory.landings.shift() ?? 0, seconds = JSON.parse(calls("/motion/leg").at(-1)![1].body).duration, count = seconds <= 3 ? 72 : 120;
    return { fps: 24, deltas: Array.from({ length: count - 1 }, (_, i) => i < (count === 72 ? 71 : 96) ? 1 : 0), frames: Array.from({ length: count }, () => new Uint8Array(2304).fill(level)) }; }),
  cutLeg: vi.fn(async (_bytes: Buffer, end: number, factor: number) => Buffer.from(`cut-${end.toFixed(3)}-${factor.toFixed(3)}`)),
  joinLegs: vi.fn(async (legs: Buffer[]) => ({ bytes: Buffer.concat(legs), media: { width: 64, height: 32, duration: 6, audio_streams: 0, source_audio_streams: 0, derivative: "silent_streamcopy_v1" } })),
}));
import { CreatorError } from "./creator-error";
import { viewHash } from "./place-view-store";
import { H3_CAMERA_ADAPTER, H3_CAMERA_ADAPTER_V1, H3_CAMERA_MODEL } from "./camera-motion";
import { orbitPosition } from "./camera-path";
import { KEYFRAME_MODEL } from "./asset-pipeline";
import { motionStudyFixture } from "../tests/fixtures/motion-study";
import { cutLeg, joinLegs, legMotion } from "./motion-video";
import sharp from "sharp";
import { finishKeyframe, keyframeGateBody, prepareKeyframeInput } from "./illustration-keyframe-server";
import { illustrationDependency, keyframeArt } from "./illustration-input";
import { ACCEPTED_ONLY_POLICY, ACCEPTED_ROUTE_POLICY, legMove, legSeconds, pathVideoAction, pathVideoBytes, pathVideoKeyframeBytes, pathVideoLibrary, processNextPathVideo, viewMove, walkVideoAction, walkVideoBytes, walkVideoLibrary } from "./path-video";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function paintedReceipt(chain: unknown, passed = true, iou?: number) {
  const bytes = Buffer.from(`kf-${++memory.painted}`), hash = sha(bytes);
  return { bytes, gate: passed ? "passed" as const : "failed" as const, candidates: [{ passed, ...(iou === undefined ? {} : { iou }) }], chosen: 0, passed, sky_pinned: false,
    final_image: { version: 1 as const, sha256: hash, candidate_sha256: hash, width: 64, height: 32, method: chain ? "depth_warp_v1" as const : "candidate" as const,
      invariants: { dimensions: true, opaque: true, composition: true, protected_pixels: 0, changed_protected_pixels: 0 } } };
}
const put = (key: string, text: string | Buffer) => { const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text); memory.files.set(key, bytes); return { key, sha256: sha(bytes), bytes: bytes.length }; };
// The accepted source: a real 64x32 PNG, as /motion/leg validates it.
const sourcePng = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#808080" } }).png().toBuffer();
const reviewedSource = () => ({ version: 1, stage: "first", object_id: null, gate: "passed", passed: true, candidates: [{ passed: true }], chosen: 0, sky_pinned: false,
  final_image: { version: 1, sha256: sha(sourcePng), candidate_sha256: sha(sourcePng), width: 64, height: 32, method: "candidate",
    invariants: { dimensions: true, opaque: true, composition: true, protected_pixels: 0, changed_protected_pixels: 0 } },
  content_approval: { version: 1, method: "owner_review", sha256: sha(sourcePng), reviewed_at: new Date().toISOString() } });
const sourceFile = () => ({ key: "source-key", sha256: sha(sourcePng), bytes: sourcePng.length });
const times = [0, .25, .5, .75, 1];
function pathStudy() {
  const base = motionStudyFixture(), camera = { projection: "perspective", projection_matrix: [], near: .1, far: 500 };
  return { ...base,
    preparation: { ...base.preparation, adapter: H3_CAMERA_ADAPTER, checkpoints: [0, 2, 4], limit_issues: ["H3 camera controls are measured only up to 30° of turn per clip"],
      path: { version: 1, duration: 6, time: 0, pivot: [0, 0, 0], target_id: "target", keyframes: [{ time: 0, azimuth: 0, elevation: 30, distance: 20 }, { time: 1, azimuth: 60, elevation: 30, distance: 10 }] } },
    source: { ...base.source, view: { width: 64, height: 32, mode: "orbit", floor_id: null, objects: [], root_place_id: "place", camera: { ...camera, world_matrix: [0] }, depth: { encoding: "linear_view_z_8bit_near_white", near: 1, far: 99 } },
      image: { asset_id: "illustration_a", ...put("source-key", sourcePng) } },
    frames: times.map((time, i) => ({ ...base.frames[i]!, camera: { ...camera, world_matrix: [time] }, depth: { near: 2 + time, far: 90 } })),
    files: times.map((_, i) => Object.fromEntries(["render", "depth", "normals", "objects"].map(pass => [pass, put(`frame${i}-${pass}`, `${pass}-${i}`)]))),
  };
}
const provider = vi.fn();
const calls = (suffix: string) => provider.mock.calls.filter(([url]) => String(url).includes(suffix));
const body = (suffix: string, n = 0) => JSON.parse(calls(suffix)[n]![1].body);
const totals = () => [...store("spend_ledger").values()].map(row => Math.round(row.total * 1e6) / 1e6 || 0);
const job = () => store("path_videos").get("world:walk")!;
const input = async (extra: Record<string, unknown> = {}) => {
  const library = await pathVideoLibrary("world", "study");
  return { action: "generate", id: "walk", confirmed: true, study_sha256: library.study_sha256, reservation: library.quote?.reservation, ...extra };
};
async function drain(limit = 80) {
  for (let i = 0; i < limit; i++) { const row = store("path_videos").get("world:walk"); if (row) row.next_check = new Date(0); if (!await processNextPathVideo(db)) return; }
  throw new Error("Path video did not settle");
}
beforeEach(() => {
  memory.rows.clear(); memory.files.clear(); memory.tail = Promise.resolve(); memory.owner = true; memory.stale = false; memory.painted = 0; memory.landings = [100, 200]; memory.keyframes = true; memory.statusDown = false; memory.onSubmit = null; memory.historical = []; memory.legFloor = 3;
  vi.clearAllMocks(); vi.mocked(finishKeyframe).mockReset().mockImplementation(async (_passes, _id, _urls, _masks, chain) => paintedReceipt(chain) as never); vi.stubGlobal("fetch", provider);
  vi.stubEnv("MODAL_API_URL", "https://backend.test"); vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES", "1"); vi.stubEnv("PATH_VIDEO_ENABLED", "1");
  vi.stubEnv("MAX_DAILY_SPEND", "0"); vi.stubEnv("MAX_SESSION_SPEND", "0"); vi.stubEnv("MOTION_DAILY_CAP_USD", "3");
  store("motion_studies").set("world:study", pathStudy());
  store("illustration_assets").set("world:illustration_a", { _id: "world:illustration_a", id: "illustration_a", session_id: "world", prompt: "Inked stone, warm light", ...sourceFile(), keyframe: reviewedSource() });
  store("generation_workers").set("worker", { _id: "worker", kind: "place-layout", motion_v1: true, motion_review_v1: true, path_video_v1: true, path_video_views_v1: true, path_video_v2: true, path_video_views_v2: true, last_seen: new Date() });
  let painted = 0, legs = 0;
  provider.mockImplementation(async (url: string) => {
    if (url.endsWith("/illustration/keyframe-capabilities")) return Response.json({ enabled: memory.keyframes, model: KEYFRAME_MODEL, reservation: memory.keyframes ? .1 : 0, parameters: { num_images: 2, prompt_version: "saved-camera-qwen-keyframe-v1" } });
    if (url.endsWith("/motion/capabilities")) return Response.json({ enabled: true, model: H3_CAMERA_MODEL, adapter: H3_CAMERA_ADAPTER, purpose: "calibration", resolution: "768P", leg_move_version: 2, reservation_usd_per_second: .08,
      ...(memory.legFloor === null ? {} : { leg_min_seconds: memory.legFloor }) });
    if (url.endsWith("/illustration/submit")) return await memory.onSubmit?.() ?? Response.json({ request_id: `kf${++painted}`, model: KEYFRAME_MODEL });
    if (url.includes("/illustration/requests/")) return Response.json({ status: "ready", images: [{ url: "https://fal.media/a.jpg" }, { url: "https://fal.media/b.jpg" }] });
    if (url.endsWith("/illustration/gate")) return Response.json({ masks: [{ mask_png: "m0" }, { mask_png: "m1" }] });
    if (url.endsWith("/motion/leg")) return Response.json({ request_id: `leg${++legs}`, model: "minimax/h3-max/image-to-video", prompt: "One continuous shot" });
    if (url.includes("/motion/requests/")) return memory.statusDown ? new Response("down", { status: 500 }) : Response.json({ status: "ready", video: { url: "https://fal.media/leg.mp4" } });
    if (url.startsWith("https://fal.media/")) return new Response(url.endsWith(".mp4") ? "raw-leg" : "candidate");
    throw new Error(`Unexpected request ${url}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("words a leg as the camera's own move: right orbit positive, rise in metres, forward toward the pivot", () => {
  const frames = [{ time: 0, azimuth: 0, elevation: 30, distance: 20 }, { time: 1, azimuth: 60, elevation: 30, distance: 10 }];
  // Forward is horizontal (d cos el) and rise vertical (d sin el), so the two never count one move twice.
  expect(legMove(frames, 0, .5, "Inn")).toEqual({ orbit_deg: 30, turn_deg: 0, rise_m: -2.5, forward_m: 4.33, subject: "Inn" });
  expect(legMove(frames, .5, 0, null)).toMatchObject({ orbit_deg: -30, rise_m: 2.5, forward_m: -4.33 });
  // Climbing over the pivot at the same distance: 10 m up and 10 m in.
  expect(legMove([{ time: 0, azimuth: 0, elevation: 0, distance: 10 }, { time: 1, azimuth: 0, elevation: 90, distance: 10 }], 0, 1, null)).toMatchObject({ rise_m: 10, forward_m: 10 });
  // A positive orbit moves the camera along its own right vector (forward x up).
  const pivot = new Vector3(), a = orbitPosition(pivot, { azimuth: 0, elevation: 0, distance: 10 }), b = orbitPosition(pivot, { azimuth: 10, elevation: 0, distance: 10 });
  const right = pivot.clone().sub(a).normalize().cross(new Vector3(0, 1, 0));
  expect(b.clone().sub(a).dot(right)).toBeGreaterThan(0);
  expect([1, 2.75, 2.857, 3.0000001, 4.8, 12, 40].map(t => legSeconds(t))).toEqual([3, 3, 3, 3, 5, 12, 15]);
});

it("paints chained keyframes, makes one POST per step, joins the legs and releases nothing it spent", async () => {
  const library = await pathVideoLibrary("world", "study");
  expect(library).toMatchObject({ checkpoints: 3, quote: { expected_cost: .68, reservation: 1.36, paid_keyframes: 2, legs: [{ seconds: 3, duration: 3, reservation: .24 }, { seconds: 3, duration: 3, reservation: .24 }] } });
  await pathVideoAction("world", "study", await input());
  expect(totals()).toEqual([1.36, 1.36, 1.36]); expect(calls("/submit")).toHaveLength(0);
  await drain();
  expect(job()).toMatchObject({ status: "ready", reservation: 1.36 }); expect(job().committed).toBeCloseTo(.68); expect(totals()).toEqual([.68, .68, .68]);
  expect(calls("/illustration/submit")).toHaveLength(2); expect(calls("/illustration/gate")).toHaveLength(2); expect(calls("/motion/leg")).toHaveLength(2);
  // Keyframe 0 is accepted artwork: chains paint with its own prompt, so no words are asked. A world without art paints from words.
  expect(library.quote).toMatchObject({ appearance: false }); expect(library.quote).not.toHaveProperty("source_prompt");
  expect(job()).toMatchObject({ prompt: "Inked stone, warm light", art: null });
  expect(body("/illustration/submit")).toMatchObject({ prompt: "Inked stone, warm light", model: KEYFRAME_MODEL, reservation: .1, parameters: { num_images: 2 }, inputs: { keyframe_stage: "chain" } });
  expect(vi.mocked(prepareKeyframeInput).mock.calls.map(call => call[2])).toEqual([null, null]);
  // Keyframe 0 is the accepted study source; keyframe 2 chains from painted keyframe 1 at its own camera and depth range.
  const chain = vi.mocked(prepareKeyframeInput).mock.calls[1]![3]!;
  expect(chain.image.toString()).toBe("kf-1"); expect(chain.depth.toString()).toBe("depth-2"); expect(chain.view.depth).toMatchObject({ near: 2.5, far: 90 });
  expect(vi.mocked(prepareKeyframeInput).mock.calls[0]![0].view).toMatchObject({ width: 64, camera: { world_matrix: [.5] }, depth: { near: 2.5 } });
  expect(vi.mocked(finishKeyframe).mock.calls[0]![3]).toEqual(["m0", "m1"]);
  const leg = body("/motion/leg");
  expect(leg).toMatchObject({ reservation: .24, duration: 3, move: { orbit_deg: 30, turn_deg: 0, rise_m: -2.5, forward_m: 4.33, subject: "Target" }, start: { width: 64, height: 32 }, end: { sha256: sha(Buffer.from("kf-1")) } });
  expect(Buffer.from(leg.start.url.split(",")[1], "base64").equals(sourcePng)).toBe(true);
  // The 3-second provider leg keeps every moving frame and matches the planned duration.
  expect(vi.mocked(cutLeg).mock.calls[0]!.slice(1)).toEqual([3, 1, { width: 64, height: 32 }]);
  expect(job().legs.map((l: Document) => [l.chosen, l.landed, l.attempts[0].metrics.ok])).toEqual([[0, true, true], [0, true, true]]);
  expect(job().keyframes.map((k: Document) => k.result?.gate ?? k.stage)).toEqual(["source", "passed", "passed"]);
  expect(vi.mocked(joinLegs)).toHaveBeenCalledTimes(1);
  expect((await pathVideoBytes("world", "study", "walk")).toString()).toBe(`cut-3.000-1.000`.repeat(2));
  expect((await pathVideoLibrary("world", "study")).jobs[0]).toMatchObject({ status: "ready", legs: [{ landed: true, attempts: [{ ok: true }] }, { landed: true }] });
});

it("paints chain keyframes with the world's art and the accepted artwork's own prompt", async () => {
  const art = put("art", "art-bytes");
  vi.mocked(keyframeArt).mockResolvedValueOnce({ key: art.key, sha256: art.sha256 });
  await pathVideoAction("world", "study", await input({ prompt: "Ignored words" }));
  expect(job()).toMatchObject({ prompt: "Inked stone, warm light", art: { key: "art", sha256: art.sha256 } });
  await drain();
  expect(job().status).toBe("ready");
  expect(vi.mocked(prepareKeyframeInput).mock.calls.map(call => String(call[2]))).toEqual(["art-bytes", "art-bytes"]);
  expect([0, 1].map(n => body("/illustration/submit", n).prompt)).toEqual(["Inked stone, warm light", "Inked stone, warm light"]);
});

it("records each keyframe's gate subject and prompts the gate with its word", async () => {
  // Near the well, no building is large enough: the gate measures the well.
  const subject = { object_id: "well", kind: "well", label: "well" };
  vi.mocked(prepareKeyframeInput).mockResolvedValueOnce({ inputs: { image_url: "data:image/png;base64,AA==" }, gate_object_id: "well", gate_subject: subject } as never);
  await pathVideoAction("world", "study", await input());
  await drain();
  expect(job().status).toBe("ready"); expect(job().keyframes[1]).toMatchObject({ gate_object_id: "well", gate_subject: subject });
  expect(vi.mocked(keyframeGateBody).mock.calls.map(call => call.slice(1, 2).concat(call[3]))).toEqual([["well", "well"], ["target", undefined]]);
});

it("claims once under concurrent workers", async () => {
  await pathVideoAction("world", "study", await input());
  job().keyframes[0].stage = "first";
  await Promise.all([processNextPathVideo(db), processNextPathVideo(db)]);
  expect(calls("/illustration/submit")).toHaveLength(1);
});

it("keeps a lost or interrupted paid response ambiguous, never resubmits it, and cancel releases only the unspent part", async () => {
  await pathVideoAction("world", "study", await input());
  memory.onSubmit = async () => { throw new Error("Lost response"); };
  await drain();
  expect(job()).toMatchObject({ status: "submission_unknown", committed: .1 }); expect(job().keyframes[1].attempt.status).toBe("submission_unknown");
  job().work_until = new Date(0); await drain();
  expect(calls("/illustration/submit")).toHaveLength(1); expect(totals()).toEqual([1.36, 1.36, 1.36]);
  await pathVideoAction("world", "study", { action: "cancel", id: "walk" }); await pathVideoAction("world", "study", { action: "cancel", id: "walk" });
  expect(job().status).toBe("cancelled"); expect(totals()).toEqual([.1, .1, .1]);
  // A claim left "submitting" by a dead worker is never sent again either.
  store("path_videos").clear(); store("spend_ledger").clear(); provider.mockClear(); memory.onSubmit = null;
  await pathVideoAction("world", "study", await input({ id: "walk" }));
  Object.assign(job(), { status: "running", committed: .1 }); job().keyframes[0].file = sourceFile();
  job().keyframes[1].attempt = { token: "dead", cost: .1, status: "submitting" };
  await drain();
  expect(job().status).toBe("submission_unknown"); expect(calls("/illustration/submit")).toHaveLength(0);
});

it("never runs the gate twice: an interrupted gate keeps candidate 0 unmeasured", async () => {
  vi.mocked(finishKeyframe).mockImplementationOnce(async (...args) => ({ ...paintedReceipt(args[4]), gate: "unmeasured", passed: false }) as never);
  await pathVideoAction("world", "study", await input());
  job().keyframes[0].file = sourceFile();
  Object.assign(job().keyframes[1], { attempt: { token: "t", cost: .1, status: "queued", request_id: "kf1" }, gate_object_id: "target", gate: { status: "started" } });
  job().committed = .1;
  await processNextPathVideo(db);
  expect(calls("/illustration/gate")).toHaveLength(0); expect(job().keyframes[1].gate).toEqual({ status: "outage" });
  expect(vi.mocked(finishKeyframe).mock.calls[0]![3]).toBeNull();
  expect(job().status).toBe("needs_review"); expect(job().keyframes[1].file).toBeDefined();
  expect(calls("/illustration/submit")).toHaveLength(0);
});

it("resumes a paused destination with a new hash-bound quote, reuses completed work and reserves once", async () => {
  gates("pass", .5, .6);
  await pathVideoAction("world", "study", await input()); await drain();
  const completed = structuredClone(job().keyframes[1]);
  const quote = (await pathVideoLibrary("world", "study")).jobs[0]!.resume_quote!;
  expect(quote).toMatchObject({ expected_cost: .58, reservation: 1.16, retry_allowance: 1 });
  const request = { action: "resume", id: "walk", confirmed: true, request_id: "resume1", ...quote };
  await expect(pathVideoAction("world", "study", { ...request, reservation: 1 })).rejects.toMatchObject({ status: 409 });
  expect(totals()).toEqual([.3, .3, .3]);
  await Promise.all([pathVideoAction("world", "study", request), pathVideoAction("world", "study", request)]);
  expect(totals()).toEqual([1.46, 1.46, 1.46]);
  expect(job().keyframes[1]).toEqual(completed); expect(job().resume_history).toHaveLength(1);
  expect(job().resume_history[0].keyframes[2].result.passed).toBe(false);
  memory.landings = [100, 0]; await drain();
  expect(job().status).toBe("ready"); expect(job().committed).toBeCloseTo(.88);
  expect(totals()).toEqual([.88, .88, .88]); expect(calls("/illustration/submit")).toHaveLength(4);
  vi.stubEnv("PATH_VIDEO_ENABLED", "0");
  await pathVideoAction("world", "study", request);
  expect(totals()).toEqual([.88, .88, .88]);
  expect((await pathVideoBytes("world", "study", "walk")).length).toBeGreaterThan(0);
});

it("checks source freshness again inside the paid claim after preparing input", async () => {
  await pathVideoAction("world", "study", await input()); await processNextPathVideo(db);
  const prepare = vi.mocked(prepareKeyframeInput), real = prepare.getMockImplementation()!;
  prepare.mockImplementationOnce(async (...args) => { const result = await real(...args); memory.stale = true; return result; });
  job().next_check = new Date(0); await processNextPathVideo(db);
  expect(job()).toMatchObject({ status: "needs_review", committed: 0 });
  expect(calls("/illustration/submit")).toHaveLength(0); expect(totals()).toEqual([0, 0, 0]);
  expect((await pathVideoLibrary("world", "study")).jobs[0]!.resume_quote).toBeNull();
});

it("rejects changed final-byte receipts and preserves the candidate without downstream spend", async () => {
  vi.mocked(finishKeyframe).mockImplementationOnce(async (...args) => {
    const receipt = paintedReceipt(args[4]); receipt.final_image.sha256 = "a".repeat(64); return receipt as never;
  });
  await pathVideoAction("world", "study", await input()); await drain();
  expect(job()).toMatchObject({ status: "needs_review", committed: .1 });
  expect(job().keyframes[1].file).toBeDefined(); expect(calls("/motion/leg")).toHaveLength(0);
});

it("does not invent a paid retry allowance for legacy jobs", async () => {
  await pathVideoAction("world", "study", await input()); delete job().retry_allowance;
  memory.landings = [0]; await drain();
  expect(job().status).toBe("needs_review"); expect(calls("/motion/leg")).toHaveLength(1);
  expect(job().reservation).toBe(1.36); expect(job().committed).toBeCloseTo(.44);
  expect(totals()).toEqual([.44, .44, .44]);
});
it("keeps legacy source artwork visible but refuses to certify it as a new chain source", async () => {
  delete store("illustration_assets").get("world:illustration_a")!.keyframe;
  expect((await pathVideoLibrary("world", "study")).reason).toMatch(/verification and review/);
  await expect(pathVideoAction("world", "study", await input())).rejects.toMatchObject({ status: 409 });
  expect(totals()).toEqual([]); expect(calls("/illustration/submit")).toHaveLength(0);
});

it("archived receipts remain playback-only even if their state is changed to needs_review", async () => {
  gates(.5, .4); await pathVideoAction("world", "study", await input()); await drain();
  job().archive_provenance = { version: 1, source_session_id: "source", source_id: "old", original_status: "needs_review", committed: .2 };
  const listed = (await pathVideoLibrary("world", "study")).jobs[0]!;
  expect(listed.resume_quote).toBeNull(); expect(listed.resume_reason).toMatch(/playback records/);
});

it("recovers final assembly without provider submissions or new spend even with generation disabled", async () => {
  const join = vi.mocked(joinLegs), real = join.getMockImplementation()!; join.mockRejectedValue(new Error("Storage outage"));
  await pathVideoAction("world", "study", await input()); await drain();
  expect(job()).toMatchObject({ status: "needs_review" }); expect(job().committed).toBeCloseTo(.68); expect(totals()).toEqual([.68, .68, .68]);
  // Lose a derivative too: the original is enough to reconstruct it offline.
  memory.files.delete(job().legs[0].attempts[0].cut.key);
  vi.stubEnv("PATH_VIDEO_ENABLED", "0"); memory.stale = true;
  const quote = (await pathVideoLibrary("world", "study")).jobs[0]!.resume_quote!;
  expect(quote).toMatchObject({ expected_cost: 0, reservation: 0, storage_only: true });
  join.mockImplementation(real);
  const submits = calls("/illustration/submit").length + calls("/motion/leg").length;
  await pathVideoAction("world", "study", { action: "resume", id: "walk", confirmed: true, request_id: "storage-recovery", ...quote });
  await drain(); expect(job().status).toBe("ready"); expect(totals()).toEqual([.68, .68, .68]);
  expect(calls("/illustration/submit").length + calls("/motion/leg").length).toBe(submits);
  expect((await pathVideoBytes("world", "study", "walk")).length).toBeGreaterThan(0);
});

it("quotes repainting a missing completed checkpoint instead of silently reusing missing bytes", async () => {
  gates("pass", .5, .4); await pathVideoAction("world", "study", await input()); await drain();
  memory.files.delete(job().keyframes[1].file.key);
  const quote = (await pathVideoLibrary("world", "study")).jobs[0]!.resume_quote!;
  expect(quote).toMatchObject({ expected_cost: .68, reservation: 1.36, storage_only: false });
});

it("quotes only a lost leg and reuses later legs when keyframe painting is disabled", async () => {
  await pathVideoAction("world", "study", await input()); await drain();
  job().status = "needs_review";
  const retained = structuredClone(job().legs[1]);
  memory.files.delete(job().legs[0].attempts[0].cut.key);
  memory.files.delete(job().legs[0].attempts[0].original.key);
  memory.keyframes = false;
  const quote = (await pathVideoLibrary("world", "study")).jobs[0]!.resume_quote!;
  expect(quote).toMatchObject({ expected_cost: .24, reservation: .48, storage_only: false });
  memory.landings = [100];
  await pathVideoAction("world", "study", { action: "resume", id: "walk", confirmed: true, request_id: "lost-leg", ...quote });
  await drain();
  expect(job().status).toBe("ready"); expect(job().legs[1]).toEqual(retained);
  expect(calls("/illustration/submit")).toHaveLength(2); expect(calls("/motion/leg")).toHaveLength(3);
  expect(job().committed).toBeCloseTo(.92); expect(totals()).toEqual([.92, .92, .92]);
  expect(job().keyframe_reservation).toBe(.1);
});

it("makes preserved failed frames reviewable with generation off and rejects corrupt or foreign previews", async () => {
  gates(.5, .4); await pathVideoAction("world", "study", await input()); await drain();
  vi.stubEnv("PATH_VIDEO_ENABLED", "0");
  expect((await pathVideoKeyframeBytes("world", "study", "walk", "1")).bytes.toString()).toBe("kf-1");
  await expect(pathVideoKeyframeBytes("world", "other", "walk", "1")).rejects.toMatchObject({ status: 404 });
  await expect(pathVideoKeyframeBytes("world", "study", "walk", "-1")).rejects.toMatchObject({ status: 400 });
  memory.files.set(job().keyframes[1].file.key, Buffer.from("changed"));
  await expect(pathVideoKeyframeBytes("world", "study", "walk", "1")).rejects.toMatchObject({ status: 503 });
});

it("pauses a landing that cannot fit the planned timing within the bounded retime", async () => {
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1 });
  savedView("v0", eye(0, 1.6, 8, 0)); savedView("v1", eye(0, 1.6, 8, -Math.PI / 6));
  for (let i = 0; i < 2; i++) vi.mocked(legMotion).mockResolvedValueOnce({ fps: 24, deltas: Array.from({ length: 119 }, (_, i) => i < 96 ? 1 : 0), frames: Array.from({ length: 120 }, () => new Uint8Array(2304).fill(200)) });
  await walkVideoAction("world", "place", await walkInput(["v0", "v1"])); await drain();
  expect(job().status).toBe("needs_review"); expect(calls("/motion/leg")).toHaveLength(2);
  expect(job().legs[0].attempts.map((a: Document) => a.metrics)).toMatchObject([{ land: 0, timing: false, ok: false }, { land: 0, timing: false, ok: false }]);
  expect(joinLegs).not.toHaveBeenCalled(); expect(job().reservation).toBe(.88); expect(job().committed).toBeCloseTo(.68);
});

it("uses the quoted retry without increasing the approved maximum", async () => {
  memory.landings = [0, 100, 200];
  await pathVideoAction("world", "study", await input()); await drain();
  expect(job()).toMatchObject({ status: "ready", reservation: 1.36, legs: [{ retry: "reserved", chosen: 1, landed: true }, { landed: true }] });
  expect(job().committed).toBeCloseTo(.92); expect(totals()).toEqual([.92, .92, .92]);
  expect(calls("/motion/leg")).toHaveLength(3);
});
it("refuses the entire maximum before any provider claim when the cap is too low", async () => {
  vi.stubEnv("MOTION_DAILY_CAP_USD", ".8");
  await expect(pathVideoAction("world", "study", await input())).rejects.toMatchObject({ status: 429 });
  expect(totals()).toEqual([]); expect(calls("/illustration/submit")).toHaveLength(0);
});

// The gate of each next painted keyframe: "pass", or a failure at this IoU.
function gates(...results: ("pass" | number)[]) {
  const finish = vi.mocked(finishKeyframe), real = finish.getMockImplementation()!;
  for (const r of results) finish.mockImplementationOnce(r === "pass" ? real
    : async (_passes: unknown, _id: unknown, _urls: unknown, _masks: unknown, chain: unknown) => paintedReceipt(chain, false, r) as never);
}
const keyframeTry = (k: number) => [job().keyframes[k].result.passed, job().keyframes[k].result.candidates[0]?.iou, String(memory.files.get(job().keyframes[k].file.key))];

it("pauses and preserves a failed destination instead of shortening the video", async () => {
  gates("pass", .5, .6);
  await pathVideoAction("world", "study", await input()); await drain();
  expect(job()).toMatchObject({ status: "needs_review", reservation: 1.36 });
  expect(job().committed).toBeCloseTo(.3); expect(totals()).toEqual([.3, .3, .3]);
  expect(job().keyframes[2]).toMatchObject({ retry: "reserved", other: { result: { passed: false } } });
  expect(keyframeTry(2)).toEqual([false, .6, "kf-3"]);
  expect(job().keyframes).toHaveLength(3); expect(job().legs).toHaveLength(2);
  expect(calls("/motion/leg")).toHaveLength(0); expect(joinLegs).not.toHaveBeenCalled();
  await expect(pathVideoBytes("world", "study", "walk")).rejects.toMatchObject({ status: 404 });
});

it("uses a keyframe whose retry passes, and chains the next one from it", async () => {
  gates(.4, "pass", "pass"); memory.landings = [200, 0];
  await pathVideoAction("world", "study", await input());
  await drain();
  expect(job()).toMatchObject({ status: "ready", reservation: 1.36 }); expect(job().committed).toBeCloseTo(.78); expect(totals()).toEqual([.78, .78, .78]);
  expect(job()).toMatchObject({ keyframes: [{}, {}, { chained_from: 1 }] });
  expect(job().keyframes[1]).toMatchObject({ retry: "reserved", other: { result: { passed: false } } }); expect(job().keyframes[1]).not.toHaveProperty("dropped");
  expect(keyframeTry(1)).toEqual([true, undefined, "kf-2"]);
  const prepare = vi.mocked(prepareKeyframeInput).mock.calls;
  expect(prepare).toHaveLength(3); expect(prepare[2]![3]!.image.toString()).toBe("kf-2");
  expect(calls("/illustration/submit")).toHaveLength(3); expect(calls("/motion/leg")).toHaveLength(2);
});

it.each(["fails again", "is refused"])("preserves a failed middle frame when its retry %s and does not chain from it", async kind => {
  gates(.5, .3);
  if (kind === "is refused") memory.onSubmit = async () => { if (calls("/illustration/submit").length === 2) return Response.json({ detail: "Keyframe generation is not configured" }, { status: 503 }); };
  await pathVideoAction("world", "study", await input()); await drain();
  const spent = kind === "fails again" ? .2 : .1;
  expect(job()).toMatchObject({ status: "needs_review", reservation: 1.36 }); expect(job().committed).toBeCloseTo(spent);
  expect(totals()).toEqual([spent, spent, spent]); expect(keyframeTry(1)).toEqual([false, .5, "kf-1"]);
  expect(job().keyframes[1]).not.toHaveProperty("dropped"); expect(job().keyframes[2].attempt).toBeUndefined();
  expect(calls("/motion/leg")).toHaveLength(0); expect(prepareKeyframeInput).toHaveBeenCalledTimes(2);
});

it("rejects oversized walk spans before painting or reserving", async () => {
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1 });
  savedView("v0", eye(0, 1.6, 8, 0)); savedView("v1", eye(5, 1.6, 8, 0));
  expect((await walkVideoLibrary("world", "place", ["v0", "v1"])).quote).toBeNull();
  await expect(walkVideoAction("world", "place", await walkInput(["v0", "v1"]))).rejects.toMatchObject({ status: 409 });
  expect(totals()).toEqual([]); expect(calls("/illustration/submit")).toHaveLength(0);
});

it("sizes legs at 5 s for a backend that does not advertise its leg floor, so an old backend never refuses a paid-for leg", async () => {
  memory.legFloor = null;
  const library = await pathVideoLibrary("world", "study");
  expect(library.quote).toMatchObject({ expected_cost: 1, reservation: 2, legs: [{ seconds: 3, duration: 5, reservation: .4 }, { seconds: 3, duration: 5, reservation: .4 }] });
  await pathVideoAction("world", "study", await input());
  await drain();
  expect(job()).toMatchObject({ status: "ready", legs: [{ duration: 5, cost: .4 }, { duration: 5, cost: .4 }] });
  expect([0, 1].map(n => body("/motion/leg", n).duration)).toEqual([5, 5]);
});

it("rejects a short turn that cannot fit an older backend before reserving or painting", async () => {
  memory.legFloor = null;
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1 });
  savedView("v0", eye(0, 1.6, 8, 0)); savedView("v1", eye(0, 1.6, 8, -Math.PI / 6));
  expect((await walkVideoLibrary("world", "place", ["v0", "v1"])).reason).toMatch(/too short/);
  await expect(walkVideoAction("world", "place", await walkInput(["v0", "v1"]))).rejects.toMatchObject({ status: 409 });
  expect(totals()).toEqual([]); expect(calls("/illustration/submit")).toHaveLength(0); expect(calls("/motion/leg")).toHaveLength(0);
});

it("pauses when keyframe 0 fails its gate twice and releases unspent funds", async () => {
  store("motion_studies").get("world:study")!.source.image.asset_id = null;
  gates(.5, .4);
  await pathVideoAction("world", "study", await input({ prompt: "Warm watercolour inn" }));
  await drain();
  expect(job()).toMatchObject({ status: "needs_review", reservation: 1.56, error: expect.stringMatching(/did not pass verification/) });
  expect(job().committed).toBeCloseTo(.2); expect(totals()).toEqual([.2, .2, .2]);
  expect(job().keyframes[0]).toMatchObject({ retry: "reserved", result: { passed: false } }); expect(job().keyframes[0]).not.toHaveProperty("dropped");
  expect(calls("/illustration/submit")).toHaveLength(2); expect(calls("/motion/leg")).toHaveLength(0);
});

it("cancels before any step and releases the whole reservation", async () => {
  await pathVideoAction("world", "study", await input());
  await pathVideoAction("world", "study", { action: "cancel", id: "walk" });
  await drain();
  expect(job().status).toBe("cancelled"); expect(totals()).toEqual([0, 0, 0]); expect(provider.mock.calls.filter(([url]) => String(url).includes("/submit") || String(url).includes("/leg"))).toHaveLength(0);
  await expect(pathVideoAction("world", "study", { action: "cancel", id: "missing" })).rejects.toMatchObject({ status: 404 });
});

it("spends nothing under MOCK_PROVIDERS and preserves a refused step for review", async () => {
  memory.keyframes = false;
  expect(await pathVideoLibrary("world", "study")).toMatchObject({ quote: null, reason: "Keyframe painting is not configured" });
  await expect(pathVideoAction("world", "study", await input({ reservation: 1 }))).rejects.toMatchObject({ status: 503 });
  expect(totals()).toEqual([]);
  // The backend turned mock after scheduling: it answers 503 before any provider POST.
  memory.keyframes = true; await pathVideoAction("world", "study", await input());
  memory.onSubmit = async () => Response.json({ detail: "Keyframe generation is not configured" }, { status: 503 });
  await drain();
  expect(job()).toMatchObject({ status: "needs_review", committed: 0 }); expect(job().keyframes[1].attempt.status).toBe("refused");
  expect(totals()).toEqual([0, 0, 0]); expect(calls("/illustration/submit")).toHaveLength(1); expect(calls("/motion/leg")).toHaveLength(0);
});

it("refuses v1 studies, studies without per-frame depth, and the flag being off", async () => {
  const study = store("motion_studies").get("world:study")!;
  study.preparation.adapter = H3_CAMERA_ADAPTER_V1;
  expect((await pathVideoLibrary("world", "study")).reason).toMatch(/no path checkpoints/);
  study.preparation.adapter = H3_CAMERA_ADAPTER; delete study.frames[2].depth;
  expect((await pathVideoLibrary("world", "study")).reason).toMatch(/depth/);
  await expect(pathVideoAction("world", "study", await input({ reservation: 1 }))).rejects.toMatchObject({ status: 409 });
  vi.stubEnv("PATH_VIDEO_ENABLED", "0");
  expect(await pathVideoLibrary("world", "study")).toMatchObject({ quote: null });
  expect(totals()).toEqual([]);
});

it.each(["refused", "failed"])("preserves an unlanded leg when its retry is %s and pauses before the next leg", async kind => {
  memory.landings = [0, 200];
  const real = provider.getMockImplementation()!;
  provider.mockImplementation(async (url: string, init?: RequestInit) => {
    if (kind === "refused" && url.endsWith("/motion/leg") && calls("/motion/leg").length === 2) return Response.json({ detail: "Motion is not configured" }, { status: 503 });
    if (kind === "failed" && url.includes("/motion/requests/leg2")) return Response.json({ status: "failed" });
    return real(url, init);
  });
  await pathVideoAction("world", "study", await input());
  await drain();
  expect(job().status).toBe("needs_review"); expect(calls("/motion/leg")).toHaveLength(2);
  expect(job().legs[0]).toMatchObject({ retry: "reserved", attempts: [{ status: "ready" }, { status: kind }] });
  // A refused retry was never sent, so its reservation is released with the rest.
  const spent = kind === "refused" ? .44 : .68;
  expect(job()).toMatchObject({ reservation: 1.36 }); expect(job().committed).toBeCloseTo(spent); expect(totals()).toEqual([spent, spent, spent]);
});

it("never abandons an unread paid result: past 20 outages it backs off to hourly checks and reads it later", async () => {
  // With nothing paid in flight, an outage still stops after 20 tries and releases everything.
  await pathVideoAction("world", "study", await input());
  memory.files.delete("source-key");
  for (let i = 0; i < 20; i++) { job().next_check = new Date(0); await processNextPathVideo(db); }
  expect(job().status).toBe("needs_review"); expect(totals()).toEqual([0, 0, 0]);
  store("path_videos").clear(); store("spend_ledger").clear(); put("source-key", sourcePng); memory.statusDown = true;
  await pathVideoAction("world", "study", await input());
  for (let i = 0; i < 40; i++) { job().next_check = new Date(0); await processNextPathVideo(db); }
  expect(job().status).toBe("running"); expect(job().committed).toBeCloseTo(.44); expect(job().errors).toBeGreaterThan(20); expect(totals()).toEqual([1.36, 1.36, 1.36]);
  expect(job().legs[0].attempts).toMatchObject([{ status: "queued", request_id: "leg1" }]);
  const wait = job().next_check.getTime() - Date.now();
  expect(wait).toBeGreaterThan(3_500_000); expect(wait).toBeLessThanOrEqual(3_600_000);
  memory.statusDown = false; await drain();
  expect(job().status).toBe("ready"); expect(calls("/motion/leg")).toHaveLength(2);
});

it("checks the accepted source the leg endpoint will read before any spend", async () => {
  const image = (width: number) => sharp({ create: { width, height: 32, channels: 3, background: "#808080" } });
  for (const bytes of [await image(64).jpeg().withMetadata({ orientation: 6 }).toBuffer(), await image(32).png().toBuffer()]) {
    store("motion_studies").get("world:study")!.source.image = { asset_id: "illustration_a", ...put("source-key", bytes) };
    expect(await pathVideoLibrary("world", "study")).toMatchObject({ quote: null, reason: "Unsupported motion source image" });
    await expect(pathVideoAction("world", "study", await input({ reservation: 1 }))).rejects.toMatchObject({ status: 409 });
  }
  expect(totals()).toEqual([]); expect(store("path_videos").size).toBe(0);
});

it.each(["nearly expired", "taken over"])("sends no paid POST when the lease is %s at claim time", async kind => {
  await pathVideoAction("world", "study", await input());
  await processNextPathVideo(db);
  // The input preparation outlives the lease, or another worker takes the job over.
  const prepare = vi.mocked(prepareKeyframeInput), real = prepare.getMockImplementation()!;
  prepare.mockImplementationOnce(async (...args) => {
    Object.assign(job(), kind === "taken over" ? { work_token: "other", work_until: new Date(Date.now() + 600_000) } : { work_until: new Date(Date.now() + 60_000) });
    return real(...args);
  });
  job().next_check = new Date(0); await processNextPathVideo(db);
  expect(prepare).toHaveBeenCalledTimes(1); expect(calls("/illustration/submit")).toHaveLength(0);
  expect(job().committed).toBe(0); expect(job().keyframes[1].attempt).toBeUndefined();
});

it("asks for appearance words only when keyframe 0 is painted from words", async () => {
  store("motion_studies").get("world:study")!.source.image.asset_id = null;
  expect((await pathVideoLibrary("world", "study")).quote).toMatchObject({ appearance: true, paid_keyframes: 3 });
  await expect(pathVideoAction("world", "study", await input())).rejects.toMatchObject({ status: 400 });
  await pathVideoAction("world", "study", await input({ prompt: " Warm watercolour inn " }));
  expect(job().prompt).toBe("Warm watercolour inn");
  // Accepted artwork without a usable prompt of its own asks for words too.
  store("motion_studies").get("world:study")!.source.image.asset_id = "illustration_a"; store("illustration_assets").get("world:illustration_a")!.prompt = "ok";
  expect((await pathVideoLibrary("world", "study")).quote).toMatchObject({ appearance: true, paid_keyframes: 2 });
});

it("releases a refused step's cost even when a cancel lands between its claim and the refusal", async () => {
  await pathVideoAction("world", "study", await input());
  memory.onSubmit = async () => {
    await pathVideoAction("world", "study", { action: "cancel", id: "walk" });
    return Response.json({ detail: "Keyframe generation is not configured" }, { status: 503 });
  };
  await drain();
  expect(job()).toMatchObject({ status: "cancelled", committed: 0 }); expect(job().keyframes[1].attempt.status).toBe("refused");
  expect(calls("/illustration/submit")).toHaveLength(1); expect(totals()).toEqual([0, 0, 0]);
});

// Walk videos: a path video over saved views. Yaw 0 looks toward -z (walk-position).
function eye(x: number, y: number, z: number, yaw: number) {
  const camera = new PerspectiveCamera(60, 2, .05, 400); camera.position.set(x, y, z); camera.rotation.set(0, yaw, 0, "YXZ"); camera.updateMatrixWorld(true);
  return camera.matrixWorld.toArray();
}
// Walk views draw the root place at its chunk offset (z = 6 here).
function savedView(id: string, world_matrix: number[], extra: Record<string, unknown> = {}) {
  const view = { _id: `world:${id}`, id, session_id: "world", root_place_id: "place", label: id, version: 1, mode: "walk", width: 64, height: 32, floor_id: null,
    camera: { projection: "perspective", world_matrix, projection_matrix: [], near: .05, far: 400 }, depth: { encoding: "linear_view_z_8bit_near_white", near: 1, far: 90 },
    normals: "view_space_rgb", surface_policy: "opaque_geometry", objects: [], assets: [], provenance: "client_rendered_saved_geometry", created_at: "", request_sha256: id,
    sources: [{ scene_id: "scene_place", place_id: "place", revision: 1, x: 0, z: 6, definition_sha256: "def" }],
    files: Object.fromEntries(["render", "depth", "normals", "objects"].map(pass => [pass, put(`${id}-${pass}`, `${pass}-${id}`)])), ...extra };
  store("place_views").set(view._id, view); return view;
}
const walkInput = async (ids: string[], extra: Record<string, unknown> = {}) => {
  const library = await walkVideoLibrary("world", "place", ids);
  return { action: "generate", id: "walk", confirmed: true, view_ids: ids, views_sha256: library.views_sha256, reservation: library.quote?.reservation, prompt: "Inked stone", ...extra };
};

it("words a walk leg from two cameras: forward on the start heading, a right turn positive, rise in metres", () => {
  expect(viewMove(eye(0, 1.6, 0, 0), eye(0, 1.6, -4, 0), null)).toEqual({ orbit_deg: 0, turn_deg: 0, rise_m: 0, forward_m: 4, subject: null });
  expect(viewMove(eye(0, 1.6, 0, 0), eye(0, 1.6, 3, 0), null)).toMatchObject({ forward_m: -3 });
  // The walk's ArrowRight lowers yaw. That turns the camera toward its own right (+x at yaw 0), and reads as a positive turn.
  const right = eye(0, 1.6, 0, -Math.PI / 6);
  expect(-right[8]!).toBeGreaterThan(0);
  expect(viewMove(eye(0, 1.6, 0, 0), right, null)).toMatchObject({ turn_deg: 30, forward_m: 0 });
  expect(viewMove(eye(0, 1.6, 0, 0), eye(0, 1.6, 0, Math.PI / 6), null)).toMatchObject({ turn_deg: -30 });
  // Facing -x: a sideways step is not forward, and a climb is a rise. Pitch does not move the heading.
  expect(viewMove(eye(0, 1.6, 0, Math.PI / 2), eye(-4, 2.6, 1, Math.PI / 2), "Inn")).toEqual({ orbit_deg: 0, turn_deg: 0, rise_m: 1, forward_m: 4, lateral_m: -1, subject: "Inn" });
  const pitched = new PerspectiveCamera(); pitched.position.set(0, 1.6, -4); pitched.rotation.set(.5, 0, 0, "YXZ"); pitched.updateMatrixWorld(true);
  expect(viewMove(eye(0, 1.6, 0, 0), pitched.matrixWorld.toArray(), null)).toMatchObject({ turn_deg: 0, forward_m: 4 });
});

it("makes one walk video over saved views, chaining each keyframe from the last across chunk offsets", async () => {
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1 });
  memory.landings = [200, 0];
  // An orbit view draws the place at the origin, so its eye (z = 2) is z = 8 in the walk views' frame.
  savedView("v0", eye(0, 1.6, 2, 0), { mode: "orbit", sources: [{ scene_id: "scene_place", place_id: "place", revision: 1, x: 0, z: 0, definition_sha256: "def" }] });
  savedView("v1", eye(0, 1.6, 4, 0)); savedView("v2", eye(0, 1.6, 4, -Math.PI / 6));
  const ids = ["v0", "v1", "v2"], library = await walkVideoLibrary("world", "place", ids);
  // 4 m at 1.4 m/s, then a turn on the spot (1.5 s). No accepted artwork at view 0, so all three keyframes are painted from words.
  expect(library).toMatchObject({ checkpoints: 3, reason: "", quote: { expected_cost: .78, reservation: 1.56, paid_keyframes: 3, appearance: true, legs: [{ seconds: 2.857, duration: 3 }, { seconds: 1.5, duration: 3 }] } });
  await walkVideoAction("world", "place", await walkInput(ids));
  expect(totals()).toEqual([1.56, 1.56, 1.56]); expect(calls("/submit")).toHaveLength(0);
  await drain();
  expect(job()).toMatchObject({ status: "ready", place_id: "place", view_ids: ids, views_sha256: library.views_sha256, reservation: 1.56, prompt: "Inked stone" });
  expect(job().committed).toBeCloseTo(.78); expect(job()).not.toHaveProperty("study_id"); expect(totals()).toEqual([.78, .78, .78]);
  expect(job().keyframes.map((k: Document) => k.stage)).toEqual(["first", "chain", "chain"]);
  expect(calls("/illustration/submit")).toHaveLength(3); expect(calls("/motion/leg")).toHaveLength(2);
  const prepare = vi.mocked(prepareKeyframeInput).mock.calls;
  expect(prepare[0]![0].view).toMatchObject({ id: "v0" }); expect(prepare[0]![3]).toBeUndefined();
  // Keyframe 1 chains from painted keyframe 0, whose camera is moved into view 1's frame (+6 m in z).
  expect(prepare[1]![3]!.image.toString()).toBe("kf-1"); expect(prepare[1]![3]!.depth.toString()).toBe("depth-v0");
  expect(prepare[1]![3]!.view.camera.world_matrix[14]).toBeCloseTo(8);
  expect(prepare[2]![0].view).toMatchObject({ id: "v2" }); expect(prepare[2]![3]!.view.camera.world_matrix[14]).toBeCloseTo(4);
  // Each leg says the real move, toward the building the end keyframe's gate measured.
  expect(body("/motion/leg", 0)).toMatchObject({ duration: 3, reservation: .24, move: { orbit_deg: 0, turn_deg: 0, rise_m: 0, forward_m: 4, subject: "Copper Kettle" }, start: { width: 64, height: 32, sha256: sha(Buffer.from("kf-1")) } });
  expect(body("/motion/leg", 1).move).toMatchObject({ turn_deg: 30, forward_m: 0, subject: "Copper Kettle" });
  expect(vi.mocked(cutLeg).mock.calls.map(call => call[2])).toEqual([2.857 / 3, 1.5 / 3].map(f => Math.max(.5, f)));
  expect((await walkVideoBytes("world", "place", "walk")).length).toBeGreaterThan(0);
  expect((await walkVideoLibrary("world", "place", null)).jobs).toMatchObject([{ id: "walk", status: "ready" }]);
  // A study's path videos do not list it.
  expect((await pathVideoLibrary("world", "study")).jobs).toEqual([]);
});

it("starts from view 0's accepted artwork when it has one", async () => {
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1 });
  savedView("v0", eye(0, 1.6, 8, 0), { accepted_illustration_id: "illustration_a", width: 64, height: 32 }); savedView("v1", eye(0, 1.6, 4, 0));
  store("illustration_assets").set("world:illustration_a", { _id: "world:illustration_a", id: "illustration_a", session_id: "world", prompt: "Inked stone, warm light", ...sourceFile(), keyframe: reviewedSource() });
  expect((await walkVideoLibrary("world", "place", ["v0", "v1"])).quote).toMatchObject({ paid_keyframes: 1, appearance: false, expected_cost: .34, reservation: .68 });
  await walkVideoAction("world", "place", await walkInput(["v0", "v1"], { prompt: "Ignored" }));
  expect(job()).toMatchObject({ prompt: "Inked stone, warm light", keyframes: [{ stage: "source", file: sourceFile() }, { stage: "chain" }] });
  await drain();
  expect(job().status).toBe("ready"); expect(calls("/illustration/submit")).toHaveLength(1);
  expect(Buffer.from(body("/motion/leg").start.url.split(",")[1], "base64").equals(sourcePng)).toBe(true);
});

it("asks H3 for each leg's planned length: the legs of a 4-leg walk cost $0.96, not $1.60", async () => {
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1 });
  const ids = [0, 1, 2, 3, 4].map(i => savedView(`v${i}`, eye(0, 1.6, 8 - 4 * i, 0)).id);
  const { quote } = await walkVideoLibrary("world", "place", ids);
  expect(quote!.legs).toEqual(Array(4).fill({ seconds: 2.857, duration: 3, reservation: .24 }));
  expect(quote!.legs.reduce((sum, leg) => sum + leg.reservation, 0)).toBeCloseTo(.96); expect(quote!.expected_cost).toBe(1.46); expect(quote!.reservation).toBe(2.92);
});

it("counts only live and ready walk videos toward the 20-job cap", async () => {
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1 });
  savedView("v0", eye(0, 1.6, 8, 0)); savedView("v1", eye(0, 1.6, 4, 0));
  const old = (i: number, status: string) => store("path_videos").set(`world:old${i}`, { _id: `world:old${i}`, id: `old${i}`, session_id: "world", place_id: "place", status,
    created_at: new Date(0), reservation: 0, committed: 0, keyframes: [], legs: [] });
  for (let i = 0; i < 20; i++) old(i, ["failed", "cancelled"][i % 2]!);
  await walkVideoAction("world", "place", await walkInput(["v0", "v1"]));
  expect(job().status).toBe("scheduled");
  for (let i = 0; i < 19; i++) old(i, ["ready", "running"][i % 2]!);
  await expect(walkVideoAction("world", "place", await walkInput(["v0", "v1"], { id: "another" }))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/20 walk videos/) });
});

it("refuses views of another place, historical views, more than 12, and a walk whose geometry changes mid-run", async () => {
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1 });
  for (let i = 0; i < 13; i++) savedView(`v${i}`, eye(0, 1.6, -i, 0));
  const reason = async (ids: string[]) => (await walkVideoLibrary("world", "place", ids)).reason;
  expect(await reason(["v0", "v1"])).toBe("");
  expect(await reason(Array.from({ length: 13 }, (_, i) => `v${i}`))).toMatch(/2 to 12 saved views/);
  expect(await reason(["v0", "v0"])).toMatch(/2 to 12 saved views/);
  store("place_views").get("world:v1")!.root_place_id = "other";
  expect(await reason(["v0", "v1"])).toMatch(/of this place/);
  store("place_views").get("world:v1")!.root_place_id = "place"; memory.historical = ["v1"];
  expect(await reason(["v0", "v1"])).toMatch(/Capture the saved scene again/);
  await expect(walkVideoAction("world", "place", await walkInput(["v0", "v1"], { reservation: .6 }))).rejects.toMatchObject({ status: 409 });
  expect(totals()).toEqual([]); expect(store("path_videos").size).toBe(0);
  // Geometry that changes after scheduling stops the job before its next paid step and releases the rest.
  memory.historical = [];
  await walkVideoAction("world", "place", await walkInput(["v0", "v1"]));
  memory.historical = ["v1"];
  await drain();
  expect(job()).toMatchObject({ status: "needs_review", committed: 0 }); expect(calls("/illustration/submit")).toHaveLength(0); expect(totals()).toEqual([0, 0, 0]);
  vi.stubEnv("PATH_VIDEO_ENABLED", "0");
  expect((await walkVideoLibrary("world", "place", null)).jobs).toHaveLength(1);
});

async function acceptedAnchors(count = 2) {
  memory.keyframes = false; memory.landings = [0];
  store("generation_workers").get("worker")!.path_video_accepted_only = true;
  const map = put("owned-map", sourcePng);
  store("place_scenes").set("world:place", { _id: "world:place", session_id: "world", source_image_key: map.key, revision: 1 });
  const views = Array.from({ length: count }, (_, i) => savedView(`v${i}`, eye(0, 1.6, -4 * i, 0),
    { width: 688, height: 384, accepted_illustration_id: `anchor${i}` }));
  const assets = [];
  for (const [i, view] of views.entries()) {
    const bytes = await sharp({ create: { width: 688, height: 384, channels: 3, background: i ? "#224488" : "#668811" } }).jpeg().toBuffer();
    const file = put(`accepted-${i}`, bytes), keyframe = reviewedSource();
    Object.assign(keyframe, { reference_profile: "source-art-map-landmarks-v1", reference: map, reference_preparation: { source_sha256: map.sha256 } });
    keyframe.final_image = { ...keyframe.final_image, sha256: file.sha256, candidate_sha256: file.sha256, width: 688, height: 384 };
    keyframe.content_approval.sha256 = file.sha256;
    const asset = { _id: `world:anchor${i}`, id: `anchor${i}`, session_id: "world", prompt: "Reviewed same fantasy street", ...file, content_type: "image/jpeg",
      view_dependency: illustrationDependency(view as never), keyframe };
    assets.push(asset); store("illustration_assets").set(asset._id, asset);
  }
  return { views, assets, map };
}
async function acceptedInput(extra: Record<string, unknown> = {}) {
  const library = await walkVideoLibrary("world", "place", ["v0", "v1"], ACCEPTED_ONLY_POLICY);
  return { action: "generate", id: "walk", confirmed: true, view_ids: ["v0", "v1"], views_sha256: library.views_sha256,
    keyframe_policy: ACCEPTED_ONLY_POLICY, accepted_anchors_sha256: library.accepted_anchors_sha256, reservation: library.quote?.reservation, ...extra };
}
it("uses exactly two accepted JPEG anchors for one five-second forty-cent leg without illustration calls or retry funding", async () => {
  const { assets } = await acceptedAnchors(), legacy = await walkVideoLibrary("world", "place", ["v0", "v1"]);
  const library = await walkVideoLibrary("world", "place", ["v0", "v1"], ACCEPTED_ONLY_POLICY);
  expect(library.views_sha256).toBe(legacy.views_sha256);
  expect(library.quote).toMatchObject({ reservation: .4, expected_cost: .4, retry_allowance: 0, paid_keyframes: 0, appearance: false, legs: [{ seconds: 5, duration: 5, reservation: .4 }] });
  const request = await acceptedInput();
  await Promise.all([walkVideoAction("world", "place", request), walkVideoAction("world", "place", request)]);
  await drain();
  expect(job()).toMatchObject({ status: "ready", keyframe_policy: ACCEPTED_ONLY_POLICY, reservation: .4, committed: .4, retry_allowance: 0, duration: 5 });
  expect(job().keyframes.map((frame: Document) => [frame.stage, frame.file.sha256])).toEqual(assets.map(asset => ["source", asset.sha256]));
  expect(calls("/motion/leg")).toHaveLength(1); expect(calls("/illustration/submit")).toHaveLength(0); expect(calls("/illustration/gate")).toHaveLength(0);
  const leg = body("/motion/leg"); expect(leg).toMatchObject({ duration: 5, reservation: .4, move: { forward_m: 4 } });
  for (const [i, side] of ["start", "end"].entries()) expect(Buffer.from(leg[side].url.split(",")[1], "base64")).toEqual(memory.files.get(assets[i]!.key));
  expect(totals()).toEqual([.4, .4, .4]);
});
it("requires a complete accepted-only worker rollout and blocks stale or forged policy intent before charging", async () => {
  await acceptedAnchors(); delete store("generation_workers").get("worker")!.path_video_accepted_only;
  expect((await walkVideoLibrary("world", "place", ["v0", "v1"], ACCEPTED_ONLY_POLICY)).quote).toBeNull();
  store("generation_workers").get("worker")!.path_video_accepted_only = true;
  const older = { _id: "old", kind: "place-layout", motion_v1: true, path_video_views_v2: true, last_seen: new Date() };
  store("generation_workers").set("old", older);
  const request = await acceptedInput({ reservation: .4 });
  await expect(walkVideoAction("world", "place", request)).rejects.toMatchObject({ status: 503 }); older.last_seen = new Date(0);
  const current = await acceptedInput();
  await expect(walkVideoAction("world", "place", { ...current, keyframe_policy: "unapproved" })).rejects.toMatchObject({ status: 400 });
  await expect(walkVideoAction("world", "place", { ...current, accepted_anchors_sha256: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
  memory.owner = false;
  await expect(walkVideoAction("world", "place", current)).rejects.toMatchObject({ status: 403 });
  expect(totals()).toEqual([]); expect(calls("/motion/leg")).toHaveLength(0);
});
it.each(["review", "second-accepted", "second-camera", "map", "source", "historical", "raw", "mime", "size"])("rejects accepted-only %s drift before reserving or submitting", async change => {
  const { assets, views } = await acceptedAnchors(), request = await acceptedInput();
  if (change === "review") delete (assets[1]!.keyframe as Document).content_approval;
  if (change === "second-accepted") (views[1]! as Document).accepted_illustration_id = "missing";
  if (change === "second-camera") views[1]!.camera.world_matrix[12] = 1;
  if (change === "map") put("owned-map", "changed source map bytes");
  if (change === "source") (assets[1]!.keyframe as Document).reference.sha256 = "0".repeat(64);
  if (change === "historical") memory.historical = ["v1"];
  if (change === "raw") memory.files.set(assets[1]!.key, Buffer.alloc(assets[1]!.bytes));
  if (change === "mime") assets[1]!.content_type = "image/png";
  if (change === "size") views[1]!.width = 640;
  await expect(walkVideoAction("world", "place", request)).rejects.toThrow();
  expect(totals()).toEqual([]); expect(store("path_videos").size).toBe(0); expect(calls("/motion/leg")).toHaveLength(0); expect(calls("/illustration/submit")).toHaveLength(0);
});
it.each(["accepted", "map", "worker"])("fences accepted-only %s changes again at the only paid claim", async change => {
  const { views } = await acceptedAnchors(); await walkVideoAction("world", "place", await acceptedInput());
  if (change === "accepted") (views[1]! as Document).accepted_illustration_id = "missing";
  if (change === "map") put("owned-map", "changed map");
  if (change === "worker") store("generation_workers").set("old", { _id: "old", kind: "place-layout", motion_v1: true, last_seen: new Date() });
  await drain();
  expect(job()).toMatchObject({ status: "needs_review", committed: 0 }); expect(totals()).toEqual([0, 0, 0]); expect(calls("/motion/leg")).toHaveLength(0);
});
it("preserves a failed accepted-only landing and never funds or submits another leg on resume", async () => {
  await acceptedAnchors(); memory.landings = [255]; await walkVideoAction("world", "place", await acceptedInput()); await drain();
  expect(job()).toMatchObject({ status: "needs_review", committed: .4, retry_allowance: 0 }); expect(job().legs[0].attempts).toHaveLength(1);
  expect(job().legs[0].attempts[0].original).toBeTruthy(); expect(job().legs[0].retry).toMatch(/no retry allowance/);
  const listed = (await walkVideoLibrary("world", "place", null)).jobs[0]!;
  expect(listed.resume_quote).toBeNull(); expect(listed.resume_reason).toMatch(/no paid retry allowance/);
  await expect(walkVideoAction("world", "place", { action: "resume", id: "walk", request_id: "retry", confirmed: true, job_sha256: "x", source_sha256: "x", reservation: .4 })).rejects.toThrow();
  expect(calls("/motion/leg")).toHaveLength(1); expect(calls("/illustration/submit")).toHaveLength(0); expect(totals()).toEqual([.4, .4, .4]);
});
it("keeps a lost accepted-only provider acknowledgement ambiguous while duplicate client acknowledgements remain free", async () => {
  await acceptedAnchors(); const request = await acceptedInput(), previous = provider.getMockImplementation()!;
  provider.mockImplementation(async (url: string, ...args) => { if (url.endsWith("/motion/leg")) throw new Error("Lost provider ACK"); return previous(url, ...args); });
  await walkVideoAction("world", "place", request); await drain();
  expect(job().status).toBe("submission_unknown"); await walkVideoAction("world", "place", request); await drain();
  expect(calls("/motion/leg")).toHaveLength(1); expect(totals()).toEqual([.4, .4, .4]);
});
it("only resumes accepted-only completed media reconstruction for free with unchanged anchors and no paid retry", async () => {
  await acceptedAnchors(); await walkVideoAction("world", "place", await acceptedInput()); await drain();
  memory.files.delete(job().video.key); delete job().video; delete job().media; job().status = "needs_review";
  const quoted = (await walkVideoLibrary("world", "place", null)).jobs[0]!.resume_quote!;
  expect(quoted).toMatchObject({ reservation: 0, expected_cost: 0, retry_allowance: 0, storage_only: true, accepted_anchors_sha256: job().accepted_anchors_sha256 });
  const request = { action: "resume", id: "walk", request_id: "free-storage", confirmed: true, ...quoted };
  await Promise.all([walkVideoAction("world", "place", request), walkVideoAction("world", "place", request)]); await drain();
  expect(job()).toMatchObject({ status: "ready", committed: .4, retry_allowance: 0 }); expect(job().resume_history).toHaveLength(1);
  expect(calls("/motion/leg")).toHaveLength(1); expect(calls("/illustration/submit")).toHaveLength(0); expect(totals()).toEqual([.4, .4, .4]);
});


async function reviewedRoute(count = 3) {
  const data = await acceptedAnchors(count);
  store("generation_workers").get("worker")!.path_video_accepted_route = true;
  const ids = data.views.map(view => view.id);
  const library = await walkVideoLibrary("world", "place", ids, ACCEPTED_ROUTE_POLICY);
  return { ...data, ids, library, request: { action: "generate", id: "walk", confirmed: true, view_ids: ids,
    views_sha256: library.views_sha256, keyframe_policy: ACCEPTED_ROUTE_POLICY,
    accepted_anchors_sha256: library.accepted_anchors_sha256, reservation: library.quote?.reservation } };
}
it("walks three reviewed cameras using exact shared JPEG anchors and two legs without painting or retry funding", async () => {
  const { assets, request, library } = await reviewedRoute();
  expect(library.quote).toMatchObject({ reservation: .8, expected_cost: .8, paid_keyframes: 0, retry_allowance: 0,
    legs: [{ seconds: 5, duration: 5, reservation: .4 }, { seconds: 5, duration: 5, reservation: .4 }] });
  await Promise.all([walkVideoAction("world", "place", request), walkVideoAction("world", "place", request)]); await drain();
  expect(job()).toMatchObject({ status: "ready", duration: 10, committed: .8, retry_allowance: 0 });
  expect(job().keyframes.map((frame: Document) => [frame.time, frame.stage, frame.file.sha256])).toEqual(assets.map((asset, i) => [i / 2, "source", asset.sha256]));
  expect(calls("/motion/leg")).toHaveLength(2); expect(calls("/illustration/")).toHaveLength(0);
  for (let i = 0; i < 2; i++) for (const [offset, side] of ["start", "end"].entries())
    expect(Buffer.from(body("/motion/leg", i)[side].url.split(",")[1], "base64")).toEqual(memory.files.get(assets[i + offset]!.key));
  expect(totals()).toEqual([.8, .8, .8]);
});
it("retimes uneven reviewed route checkpoints uniformly without changing their camera moves", async () => {
  const { views, ids } = await reviewedRoute();
  views[2]!.camera.world_matrix[14] = -5;
  store("illustration_assets").get("world:anchor2")!.view_dependency = illustrationDependency(views[2] as never);
  const library = await walkVideoLibrary("world", "place", ids, ACCEPTED_ROUTE_POLICY);
  await walkVideoAction("world", "place", { action: "generate", id: "walk", confirmed: true, view_ids: ids,
    views_sha256: library.views_sha256, keyframe_policy: ACCEPTED_ROUTE_POLICY,
    accepted_anchors_sha256: library.accepted_anchors_sha256, reservation: library.quote?.reservation });
  expect(job().keyframes.map((frame: Document) => frame.time)).toEqual([0, .5, 1]);
  expect(job().legs.map((leg: Document) => [leg.seconds, leg.move.forward_m])).toEqual([[5, 4], [5, 1]]);
});
it.each(["missing", "review", "checkpoint", "camera", "bytes"])("blocks a reviewed route with %s at an interior camera before spend", async change => {
  const { request, views, assets } = await reviewedRoute();
  if (change === "missing") delete (views[1]! as Document).accepted_illustration_id;
  if (change === "review") delete (assets[1]!.keyframe as Document).content_approval;
  if (change === "checkpoint") (views[1]! as Document).walk_checkpoint = true;
  if (change === "camera") views[1]!.camera.world_matrix[12] = .1;
  if (change === "bytes") memory.files.set(assets[1]!.key, Buffer.alloc(assets[1]!.bytes));
  await expect(walkVideoAction("world", "place", request)).rejects.toThrow();
  expect(store("path_videos").size).toBe(0); expect(totals()).toEqual([]); expect(calls("/motion/leg")).toHaveLength(0);
});
it("requires the route worker rollout while preserving two-anchor v1 quotes", async () => {
  const { ids } = await reviewedRoute(); delete store("generation_workers").get("worker")!.path_video_accepted_route;
  expect((await walkVideoLibrary("world", "place", ids, ACCEPTED_ROUTE_POLICY)).quote).toBeNull();
  expect((await walkVideoLibrary("world", "place", ["v0", "v1"], ACCEPTED_ONLY_POLICY)).quote?.reservation).toBe(.4);
  store("generation_workers").get("worker")!.path_video_accepted_route = true;
  store("generation_workers").set("old", { _id: "old", kind: "place-layout", motion_v1: true, path_video_views_v2: true, path_video_accepted_only: true, last_seen: new Date() });
  expect((await walkVideoLibrary("world", "place", ids, ACCEPTED_ROUTE_POLICY)).quote).toBeNull();
  expect(calls("/motion/leg")).toHaveLength(0); expect(totals()).toEqual([]);
});
it("fences every reviewed anchor again before each route leg and preserves the completed first leg", async () => {
  const { request, views } = await reviewedRoute(); await walkVideoAction("world", "place", request);
  for (let i = 0; i < 20 && !job().legs[0].landed; i++) { job().next_check = new Date(0); await processNextPathVideo(db); }
  expect(job().legs[0].landed).toBe(true); expect(calls("/motion/leg")).toHaveLength(1);
  (views[2]! as Document).accepted_illustration_id = "changed"; await drain();
  expect(job()).toMatchObject({ status: "needs_review", committed: .4 }); expect(calls("/motion/leg")).toHaveLength(1);
  expect(totals()).toEqual([.4, .4, .4]);
});
it("preserves a failed route landing without submitting future legs or paid resume", async () => {
  const { request } = await reviewedRoute(); memory.landings = [255]; await walkVideoAction("world", "place", request); await drain();
  expect(job()).toMatchObject({ status: "needs_review", committed: .4 }); expect(job().legs[0].attempts).toHaveLength(1);
  expect(calls("/motion/leg")).toHaveLength(1); expect(totals()).toEqual([.4, .4, .4]);
  expect((await walkVideoLibrary("world", "place", null)).jobs[0]!.resume_quote).toBeNull();
});
it("permits only free media reconstruction of a completed reviewed route and retains all accepted anchor bindings", async () => {
  const { request } = await reviewedRoute(); await walkVideoAction("world", "place", request); await drain();
  memory.files.delete(job().video.key); delete job().video; delete job().media; job().status = "needs_review";
  const quote = (await walkVideoLibrary("world", "place", null)).jobs[0]!.resume_quote!;
  expect(quote).toMatchObject({ reservation: 0, storage_only: true, retry_allowance: 0, accepted_anchors_sha256: job().accepted_anchors_sha256 });
  await walkVideoAction("world", "place", { action: "resume", id: "walk", request_id: "free", confirmed: true, ...quote }); await drain();
  expect(job()).toMatchObject({ status: "ready", committed: .8 }); expect(calls("/motion/leg")).toHaveLength(2); expect(totals()).toEqual([.8, .8, .8]);
});
it("quotes all twelve reviewed cameras and rejects a thirteenth before reserving", async () => {
  const { ids, library } = await reviewedRoute(12);
  expect(library.quote).toMatchObject({ reservation: 4.4, paid_keyframes: 0, retry_allowance: 0 }); expect(library.quote?.legs).toHaveLength(11);
  expect(await walkVideoLibrary("world", "place", [...ids, "extra"], ACCEPTED_ROUTE_POLICY)).toMatchObject({ quote: null, reason: "A walk video needs 2 to 12 saved views" });
  expect(totals()).toEqual([]); expect(calls("/motion/leg")).toHaveLength(0);
});

it.each(["missing-anchor", "paid-image", "repeated-leg", "timing"])("refuses a tampered reviewed-route %s receipt at claim without spend", async change => {
  const { request } = await reviewedRoute(); await walkVideoAction("world", "place", request);
  if (change === "missing-anchor") delete job().keyframes[1].file;
  if (change === "paid-image") job().keyframes[1].attempt = { token: "forged", cost: .1, status: "failed" };
  if (change === "repeated-leg") job().legs[0].attempts = [{ token: "one", cost: .4, status: "failed" }, { token: "two", cost: .4, status: "failed" }];
  if (change === "timing") job().keyframes[1].time = .3;
  await drain(); expect(job()).toMatchObject({ status: "needs_review", committed: 0 });
  expect(calls("/motion/leg")).toHaveLength(0); expect(calls("/illustration/")).toHaveLength(0); expect(totals()).toEqual([0, 0, 0]);
});
it("keeps a lost route provider acknowledgement ambiguous without submitting a later leg", async () => {
  const { request } = await reviewedRoute(), previous = provider.getMockImplementation()!;
  provider.mockImplementation(async (url: string, ...args) => { if (url.endsWith("/motion/leg")) throw new Error("Lost ACK"); return previous(url, ...args); });
  await walkVideoAction("world", "place", request); await drain(); await walkVideoAction("world", "place", request); await drain();
  expect(job()).toMatchObject({ status: "submission_unknown", committed: .4 }); expect(calls("/motion/leg")).toHaveLength(1);
  await walkVideoAction("world", "place", { action: "cancel", id: "walk" }); expect(totals()).toEqual([.4, .4, .4]);
});
