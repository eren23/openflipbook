import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ClientSession, Db, Document } from "mongodb";
import { Vector3 } from "three";
const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, Document>>(), files: new Map<string, Buffer>(), tail: Promise.resolve(),
  stale: false, painted: 0, landings: [] as number[], keyframes: true, statusDown: false, onSubmit: null as (() => Promise<Response | void>) | null }));
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
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => db }));
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
vi.mock("./illustration-keyframe-server", () => ({
  prepareKeyframeInput: vi.fn(async (_passes: unknown, _sources: unknown, _art: unknown, chain?: unknown) => ({ inputs: { image_url: "data:image/png;base64,AA==", keyframe_stage: chain ? "chain" : "first" }, gate_object_id: "target" })),
  keyframeGateBody: vi.fn(async (_passes: unknown, id: string | null, urls: string[]) => id ? { image_urls: urls, box: [0, 0, 8, 8], width: 64, height: 32, label: "building" } : null),
  finishKeyframe: vi.fn(async () => ({ bytes: Buffer.from(`kf-${++memory.painted}`), gate: "passed", candidates: [], chosen: 0, passed: true, sky_pinned: false })),
}));
// The grey level each keyframe reduces to, and the level each leg's cut frame lands on.
// The source image reduces to 0.
const grey: Record<string, number> = { "kf-1": 100, "kf-2": 200 };
vi.mock("./motion-video", async original => ({ ...(await original<object>()),
  grayFrame: vi.fn(async (bytes: Buffer) => new Uint8Array(2304).fill(grey[bytes.toString()] ?? 0)),
  legMotion: vi.fn(async () => { const level = memory.landings.shift() ?? 0;
    return { fps: 24, deltas: Array.from({ length: 119 }, (_, i) => i < 96 ? 1 : 0), frames: Array.from({ length: 120 }, () => new Uint8Array(2304).fill(level)) }; }),
  cutLeg: vi.fn(async (_bytes: Buffer, end: number, factor: number) => Buffer.from(`cut-${end.toFixed(3)}-${factor.toFixed(3)}`)),
  joinLegs: vi.fn(async (legs: Buffer[]) => ({ bytes: Buffer.concat(legs), media: { width: 64, height: 32, duration: 6, audio_streams: 0, source_audio_streams: 0, derivative: "silent_streamcopy_v1" } })),
}));
import { CreatorError } from "./creator-error";
import { viewHash } from "./place-view-store";
import { H3_CAMERA_ADAPTER, H3_CAMERA_ADAPTER_V1, H3_CAMERA_MODEL } from "./camera-motion";
import { orbitPosition } from "./camera-path";
import { KEYFRAME_MODEL } from "./asset-pipeline";
import { motionStudyFixture } from "../tests/fixtures/motion-study";
import { cutLeg, joinLegs } from "./motion-video";
import sharp from "sharp";
import { finishKeyframe, prepareKeyframeInput } from "./illustration-keyframe-server";
import { legMove, legSeconds, pathVideoAction, pathVideoBytes, pathVideoLibrary, processNextPathVideo } from "./path-video";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const put = (key: string, text: string | Buffer) => { const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text); memory.files.set(key, bytes); return { key, sha256: sha(bytes), bytes: bytes.length }; };
// The accepted source: a real 64x32 PNG, as /motion/leg validates it.
const sourcePng = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#808080" } }).png().toBuffer();
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
  memory.rows.clear(); memory.files.clear(); memory.tail = Promise.resolve(); memory.stale = false; memory.painted = 0; memory.landings = [100, 200]; memory.keyframes = true; memory.statusDown = false; memory.onSubmit = null;
  vi.clearAllMocks(); vi.stubGlobal("fetch", provider);
  vi.stubEnv("MODAL_API_URL", "https://backend.test"); vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES", "1"); vi.stubEnv("PATH_VIDEO_ENABLED", "1");
  vi.stubEnv("MAX_DAILY_SPEND", "0"); vi.stubEnv("MAX_SESSION_SPEND", "0"); vi.stubEnv("MOTION_DAILY_CAP_USD", "3");
  store("motion_studies").set("world:study", pathStudy());
  store("generation_workers").set("worker", { _id: "worker", kind: "place-layout", motion_v1: true, motion_review_v1: true, path_video_v1: true, last_seen: new Date() });
  let painted = 0, legs = 0;
  provider.mockImplementation(async (url: string) => {
    if (url.endsWith("/illustration/keyframe-capabilities")) return Response.json({ enabled: memory.keyframes, model: KEYFRAME_MODEL, reservation: memory.keyframes ? .1 : 0, parameters: { num_images: 2, prompt_version: "saved-camera-qwen-keyframe-v1" } });
    if (url.endsWith("/motion/capabilities")) return Response.json({ enabled: true, model: H3_CAMERA_MODEL, adapter: H3_CAMERA_ADAPTER, purpose: "calibration", resolution: "768P", reservation_usd_per_second: .08 });
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
  expect([1, 4, 4.8, 8, 12, 40].map(legSeconds)).toEqual([5, 5, 6, 10, 15, 15]);
});

it("paints chained keyframes, makes one POST per step, joins the legs and releases nothing it spent", async () => {
  const library = await pathVideoLibrary("world", "study");
  expect(library).toMatchObject({ checkpoints: 3, quote: { reservation: 1, paid_keyframes: 2, legs: [{ seconds: 3, duration: 5, reservation: .4 }, { seconds: 3, duration: 5, reservation: .4 }] } });
  await pathVideoAction("world", "study", await input());
  expect(totals()).toEqual([1, 1, 1]); expect(calls("/submit")).toHaveLength(0);
  await drain();
  expect(job()).toMatchObject({ status: "ready", reservation: 1, committed: 1 }); expect(totals()).toEqual([1, 1, 1]);
  expect(calls("/illustration/submit")).toHaveLength(2); expect(calls("/illustration/gate")).toHaveLength(2); expect(calls("/motion/leg")).toHaveLength(2);
  // Every paid keyframe chains from the accepted artwork, so no appearance words are asked or used.
  expect(library.quote).toMatchObject({ appearance: false }); expect(job().prompt).toBe("Match the accepted artwork");
  expect(body("/illustration/submit")).toMatchObject({ prompt: "Match the accepted artwork", model: KEYFRAME_MODEL, reservation: .1, parameters: { num_images: 2 }, inputs: { keyframe_stage: "chain" } });
  // Keyframe 0 is the accepted study source; keyframe 2 chains from painted keyframe 1 at its own camera and depth range.
  const chain = vi.mocked(prepareKeyframeInput).mock.calls[1]![3]!;
  expect(chain.image.toString()).toBe("kf-1"); expect(chain.depth.toString()).toBe("depth-2"); expect(chain.view.depth).toMatchObject({ near: 2.5, far: 90 });
  expect(vi.mocked(prepareKeyframeInput).mock.calls[0]![0].view).toMatchObject({ width: 64, camera: { world_matrix: [.5] }, depth: { near: 2.5 } });
  expect(vi.mocked(finishKeyframe).mock.calls[0]![3]).toEqual(["m0", "m1"]);
  const leg = body("/motion/leg");
  expect(leg).toMatchObject({ reservation: .4, duration: 5, move: { orbit_deg: 30, turn_deg: 0, rise_m: -2.5, forward_m: 4.33, subject: "Target" }, start: { width: 64, height: 32 }, end: { sha256: sha(Buffer.from("kf-1")) } });
  expect(Buffer.from(leg.start.url.split(",")[1], "base64").equals(sourcePng)).toBe(true);
  // The trim keeps every moving frame (97 of 24 fps) and retimes it to the planned 3 s.
  expect(vi.mocked(cutLeg).mock.calls[0]!.slice(1)).toEqual([97 / 24, 3 / (97 / 24), { width: 64, height: 32 }]);
  expect(job().legs.map((l: Document) => [l.chosen, l.landed, l.attempts[0].metrics.ok])).toEqual([[0, true, true], [0, true, true]]);
  expect(job().keyframes.map((k: Document) => k.result?.gate ?? k.stage)).toEqual(["source", "passed", "passed"]);
  expect(vi.mocked(joinLegs)).toHaveBeenCalledTimes(1);
  expect((await pathVideoBytes("world", "study", "walk")).toString()).toBe(`cut-${(97 / 24).toFixed(3)}-${(72 / 97).toFixed(3)}`.repeat(2));
  expect((await pathVideoLibrary("world", "study")).jobs[0]).toMatchObject({ status: "ready", legs: [{ landed: true, attempts: [{ ok: true }] }, { landed: true }] });
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
  expect(calls("/illustration/submit")).toHaveLength(1); expect(totals()).toEqual([1, 1, 1]);
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
  await pathVideoAction("world", "study", await input());
  job().keyframes[0].file = sourceFile();
  Object.assign(job().keyframes[1], { attempt: { token: "t", cost: .1, status: "queued", request_id: "kf1" }, gate_object_id: "target", gate: { status: "started" } });
  job().committed = .1;
  await processNextPathVideo(db);
  expect(calls("/illustration/gate")).toHaveLength(0); expect(job().keyframes[1].gate).toEqual({ status: "outage" });
  expect(vi.mocked(finishKeyframe).mock.calls[0]![3]).toBeNull();
});

it.each(["retry", "capped"])("checks every landing, with exactly one separately reserved retry (%s)", async kind => {
  if (kind === "capped") vi.stubEnv("MOTION_DAILY_CAP_USD", "1");
  memory.landings = [0, 50, 200];
  await pathVideoAction("world", "study", await input());
  await drain();
  const [first] = job().legs;
  expect(job().status).toBe("ready");
  if (kind === "retry") {
    expect(calls("/motion/leg")).toHaveLength(3); expect(first.attempts.map((a: Document) => a.metrics.land)).toEqual([1, .5]);
    expect(first).toMatchObject({ retry: "reserved", chosen: 1, landed: false });
    expect(job()).toMatchObject({ reservation: 1.4, committed: 1.4 }); expect(totals()).toEqual([1.4, 1.4, 1.4]);
  } else {
    // The cap refuses the retry: the leg keeps its only attempt and is flagged.
    expect(calls("/motion/leg")).toHaveLength(2); expect(first).toMatchObject({ chosen: 0, landed: false, retry: expect.stringContaining("Retry not reserved") });
    expect(totals()).toEqual([1, 1, 1]);
  }
});

it("cancels before any step and releases the whole reservation", async () => {
  await pathVideoAction("world", "study", await input());
  await pathVideoAction("world", "study", { action: "cancel", id: "walk" });
  await drain();
  expect(job().status).toBe("cancelled"); expect(totals()).toEqual([0, 0, 0]); expect(provider.mock.calls.filter(([url]) => String(url).includes("/submit") || String(url).includes("/leg"))).toHaveLength(0);
  await expect(pathVideoAction("world", "study", { action: "cancel", id: "missing" })).rejects.toMatchObject({ status: 404 });
});

it("spends nothing under MOCK_PROVIDERS: no quote, and a refused paid step fails the job with the reservation released", async () => {
  memory.keyframes = false;
  expect(await pathVideoLibrary("world", "study")).toMatchObject({ quote: null, reason: "Keyframe painting is not configured" });
  await expect(pathVideoAction("world", "study", await input({ reservation: 1 }))).rejects.toMatchObject({ status: 503 });
  expect(totals()).toEqual([]);
  // The backend turned mock after scheduling: it answers 503 before any provider POST.
  memory.keyframes = true; await pathVideoAction("world", "study", await input());
  memory.onSubmit = async () => Response.json({ detail: "Keyframe generation is not configured" }, { status: 503 });
  await drain();
  expect(job()).toMatchObject({ status: "failed", committed: 0 }); expect(job().keyframes[1].attempt.status).toBe("refused");
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
  await expect(pathVideoLibrary("world", "study")).rejects.toMatchObject({ status: 404 });
  expect(totals()).toEqual([]);
});

it.each(["refused", "failed"])("keeps the usable first attempt when its retry is %s, and goes on to the next leg", async kind => {
  memory.landings = [0, 200];
  const real = provider.getMockImplementation()!;
  provider.mockImplementation(async (url: string, init?: RequestInit) => {
    if (kind === "refused" && url.endsWith("/motion/leg") && calls("/motion/leg").length === 2) return Response.json({ detail: "Motion is not configured" }, { status: 503 });
    if (kind === "failed" && url.includes("/motion/requests/leg2")) return Response.json({ status: "failed" });
    return real(url, init);
  });
  await pathVideoAction("world", "study", await input());
  await drain();
  expect(job().status).toBe("ready"); expect(calls("/motion/leg")).toHaveLength(3);
  expect(job().legs[0]).toMatchObject({ retry: "reserved", chosen: 0, landed: false, attempts: [{ status: "ready" }, { status: kind }] });
  // A refused retry was never sent, so its reservation is released with the rest.
  const spent = kind === "refused" ? 1 : 1.4;
  expect(job()).toMatchObject({ reservation: 1.4, committed: spent }); expect(totals()).toEqual([spent, spent, spent]);
});

it("never abandons an unread paid result: past 20 outages it backs off to hourly checks and reads it later", async () => {
  // With nothing paid in flight, an outage still stops after 20 tries and releases everything.
  await pathVideoAction("world", "study", await input());
  memory.files.delete("source-key");
  for (let i = 0; i < 20; i++) { job().next_check = new Date(0); await processNextPathVideo(db); }
  expect(job().status).toBe("failed"); expect(totals()).toEqual([0, 0, 0]);
  store("path_videos").clear(); store("spend_ledger").clear(); put("source-key", sourcePng); memory.statusDown = true;
  await pathVideoAction("world", "study", await input());
  for (let i = 0; i < 40; i++) { job().next_check = new Date(0); await processNextPathVideo(db); }
  expect(job().status).toBe("running"); expect(job().committed).toBeCloseTo(.6); expect(job().errors).toBeGreaterThan(20); expect(totals()).toEqual([1, 1, 1]);
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
