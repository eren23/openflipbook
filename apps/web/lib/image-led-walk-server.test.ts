// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
import type { ImageLedWalkDoc } from "./image-led-walk";

const state = vi.hoisted(() => ({ owner: vi.fn(), reserve: vi.fn(), source: vi.fn(), current: vi.fn(), fence: vi.fn(), read: vi.fn(), prepare: vi.fn(), verify: vi.fn(), db: null as Db | null, queue: Promise.resolve() }));
vi.mock("./creator", async () => ({ ...await vi.importActual<Record<string, unknown>>("./creator"), requireCreator: state.owner }));
vi.mock("./motion-execution", () => ({ verified: state.verify }));
vi.mock("./generation-reservation", () => ({ reserveGenerationSpend: state.reserve }));
vi.mock("./db", () => ({ withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>) => {
  const prior = state.queue; let release!: () => void;
  state.queue = new Promise<void>(resolve => { release = resolve; });
  await prior; try { return await run(state.db!, {} as ClientSession); } finally { release(); }
} }));
vi.mock("./image-led-walk-source", async () => ({ ...await vi.importActual<Record<string, unknown>>("./image-led-walk-source"),
  imageLedSourceContext: state.source, requireImageLedCurrent: state.current, fenceImageLedSource: state.fence, readImageLedImage: state.read, prepareImageLedLandmarks: state.prepare }));
import { createImageLedWalk, imageLedAction, imageLedDetail, IMAGE_LED_PARAMETERS } from "./image-led-walk-server";
import { imageLedHash, imageLedRoute } from "./image-led-walk-source";
import { CreatorError } from "./creator-error";
import { IMAGE_LED_STILL_PROFILES } from "./image-led-walk-profiles";

const routeId = "11111111-1111-4111-8111-111111111111", requestId = "22222222-2222-4222-8222-222222222222", aliasId = "33333333-3333-4333-8333-333333333333";
const sha = "a".repeat(64), image = { key: "world/map.png", sha256: sha, bytes: 100, content_type: "image/png" as const, width: 64, height: 64 };
const source = { node_id: "map", image_key: image.key, image, map_frame: { bounds: { x: 0, y: 0, w: 100, h: 100 }, parent_id: null }, source_projection: "illustrated_oblique_or_unknown" as const, binding_sha256: "b".repeat(64) };
const landmark = { id: "bookshop", entity_id: "bookshop", label: "Bookshop", visual: "Projecting book-filled bay", source_rectangle: { left: 0, top: 0, width: 64, height: 64 }, reference_kind: "reviewed_source_crop" as const, image };
let tables: Map<string, Map<string, Document>>, reservation = .15;
const valueAt = (row: Document, key: string) => key.split(".").reduce<unknown>((value, part) => (value as Document | undefined)?.[part], row);
const matches = (row: Document, query: Document): boolean => Object.entries(query).every(([key, value]) => {
  if (key === "$or") return value.some((q: Document) => matches(row, q));
  const actual = valueAt(row, key);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("$exists" in value) return (actual !== undefined) === value.$exists;
    if ("$ne" in value) return actual !== value.$ne;
    if ("$gt" in value) return actual !== undefined && Number(actual) > Number(value.$gt);
  }
  return actual === value;
});
function setAt(row: Document, key: string, value: unknown) {
  const parts = key.split("."); let object = row;
  for (const part of parts.slice(0, -1)) object = object[part];
  object[parts.at(-1)!] = structuredClone(value);
}
function memoryDb() {
  return { collection(name: string) {
    let table = tables.get(name); if (!table) { table = new Map(); tables.set(name, table); }
    const find = (query: Document) => [...table!.values()].find(row => matches(row, query));
    return { findOne: async (query: Document) => structuredClone(find(query) ?? null),
      countDocuments: async (query: Document) => [...table!.values()].filter(row => matches(row, query)).length,
      insertOne: async (row: Document) => { if (table!.has(row._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); table!.set(row._id, structuredClone(row)); return { insertedId: row._id }; },
      updateOne: async (query: Document, update: Document) => { const row = find(query); if (!row) return { matchedCount: 0 }; for (const [key, value] of Object.entries(update.$set ?? {})) setAt(row, key, value); for (const [key, value] of Object.entries(update.$inc ?? {})) setAt(row, key, Number(valueAt(row, key) ?? 0) + Number(value)); return { matchedCount: 1 }; },
      findOneAndUpdate: async (query: Document, update: Document) => { const row = find(query); if (!row) return null; for (const [key, value] of Object.entries(update.$set ?? {})) setAt(row, key, value); for (const [key, value] of Object.entries(update.$inc ?? {})) setAt(row, key, Number(valueAt(row, key) ?? 0) + Number(value)); return structuredClone(row); },
    };
  } } as unknown as Db;
}
const createBody = () => ({ id: routeId, source_node_id: "map", map_frame: source.map_frame, points: [{ x: .5, y: .9 }, { x: .5, y: .7 }], landmark_ids: ["bookshop"] });
const storedWalk = () => tables.get("image_led_walks")!.get(`world:${routeId}`)! as ImageLedWalkDoc;
beforeEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); Object.values(state).forEach(value => { if (vi.isMockFunction(value)) value.mockReset(); });
  tables = new Map(); state.queue = Promise.resolve(); state.db = memoryDb(); reservation = .15;
  state.verify.mockResolvedValue(Buffer.from("verified-video"));
  state.owner.mockResolvedValue(state.db); state.reserve.mockResolvedValue(["ledger"]); state.fence.mockResolvedValue(undefined);
  state.source.mockResolvedValue({ source, recipes: [landmark] }); state.current.mockResolvedValue({ source }); state.prepare.mockResolvedValue([landmark]);
  state.read.mockImplementation(async (key: string, expected?: {sha256:string;bytes:number}) => ({ image: { ...image, key, ...expected }, bytes: Buffer.alloc(100), url: "data:image/png;base64,c2F2ZWQ=" }));
  tables.set("generation_workers", new Map([["worker", { _id: "worker", kind: "place-layout", mesh: true, image_led_walk_v4_canvas_v1: true, last_seen: new Date() }]]));
  vi.stubEnv("MODAL_API_URL", "http://fixture.invalid");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, profile: "image-led-v1", model: "fal-ai/nano-banana-pro/edit", parameters: IMAGE_LED_PARAMETERS, reservation }), { headers: { "Content-Type": "application/json" } })));
});

async function scheduleBody(id = requestId) {
  const detail = await imageLedDetail("world", routeId, "still", 0); expect(detail.quote).not.toBeNull();
  return { action: "schedule", id, kind: "still", index: 0, quote: detail.quote!, confirmed: true };
}

it("rejects a foreign owner before reading sources, writing crops or quoting", async () => {
  state.owner.mockRejectedValue(new CreatorError("Not owner", 403));
  await expect(createImageLedWalk("world", createBody())).rejects.toMatchObject({ status: 403 });
  expect(state.source).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("keeps a free source-bound route durable and replays its same UUID without rereading or changing originals", async () => {
  const first = await createImageLedWalk("world", createBody()); state.source.mockRejectedValue(new Error("storage subsequently offline"));
  const second = await createImageLedWalk("world", createBody()); expect(second.walk.id).toBe(first.walk.id); expect(state.prepare).toHaveBeenCalledOnce();
  expect(state.reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(second.walk.source.image.sha256).toBe(sha); expect(second.walk.route.map_sha256).toBe(sha);
  await expect(createImageLedWalk("world", { ...createBody(), points: [{ x: .4, y: .8 }, { x: .5, y: .6 }] })).rejects.toMatchObject({ status: 409 });
});
it("claims a quoted step before worker submission and reuses an acknowledged request without spending again", async () => {
  await createImageLedWalk("world", createBody()); const body = await scheduleBody();
  const first = await imageLedAction("world", routeId, body); const requests = tables.get("image_led_walk_steps")!;
  expect(first.walk.frames[0]).toMatchObject({ job_id: requestId, status: "scheduled" }); expect(requests.size).toBe(1); expect(state.reserve).toHaveBeenCalledOnce();
  state.current.mockRejectedValue(new Error("lost source storage")); const second = await imageLedAction("world", routeId, body);
  expect(second.walk.frames[0]!.job_id).toBe(requestId); expect(state.reserve).toHaveBeenCalledOnce();
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});
it("prepares a free quote through the owner action without creating a claim or changing the walk", async () => {
  await createImageLedWalk("world", createBody()); const before = structuredClone(storedWalk());
  const detail = await imageLedAction("world", routeId, { action: "quote", kind: "still", index: 0 });
  expect(detail).toMatchObject({ quote: { model: "fal-ai/nano-banana-pro/edit", index: 0 } });
  expect(storedWalk()).toEqual(before); expect(state.reserve).not.toHaveBeenCalled();
  expect(tables.get("image_led_walk_steps")?.size ?? 0).toBe(0);
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});
it("rejects foreign or changed repair provenance and quote submission fields without reserving", async () => {
  await createImageLedWalk("world", createBody());
  const body = { action: "quote", kind: "still", index: 0 };
  await expect(imageLedAction("world", routeId, { ...body, confirmed: true })).rejects.toMatchObject({ status: 400 });
  await expect(imageLedAction("world", routeId, { ...body, repair: { checkpoint_index: 0, source_sha256: "0".repeat(64), target_sha256: sha, image } })).rejects.toMatchObject({ status: 409 });
  state.owner.mockRejectedValueOnce(new CreatorError("Not owner", 403));
  await expect(imageLedAction("world", routeId, body)).rejects.toMatchObject({ status: 403 });
  expect(state.reserve).not.toHaveBeenCalled(); expect(tables.get("image_led_walk_steps")?.size ?? 0).toBe(0);
});
it("allows only one concurrent quote claim, even when two tabs use different UUIDs", async () => {
  await createImageLedWalk("world", createBody()); const body = await scheduleBody();
  const results = await Promise.allSettled([imageLedAction("world", routeId, body), imageLedAction("world", routeId, { ...body, id: aliasId })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(tables.get("image_led_walk_steps")!.size).toBe(1); expect(state.reserve).toHaveBeenCalledOnce();
});
it("binds a claimed UUID to its exact kind, index, quote and source body", async () => {
  await createImageLedWalk("world", createBody()); const body = await scheduleBody(); await imageLedAction("world", routeId, body);
  await expect(imageLedAction("world", routeId, { ...body, index: 1 })).rejects.toMatchObject({ status: 409 });
  await expect(imageLedAction("world", routeId, { ...body, kind: "video" })).rejects.toMatchObject({ status: 409 });
  expect(state.reserve).toHaveBeenCalledOnce();
});
it.each(["price", "source", "route", "proof"])("blocks changed %s before making a paid claim", async field => {
  await createImageLedWalk("world", createBody()); const body = await scheduleBody();
  if (field === "price") reservation = .3;
  if (field === "source") state.current.mockRejectedValue(new CreatorError("Saved artwork bytes changed", 409));
  if (field === "route") body.quote.route_sha256 = "0".repeat(64);
  if (field === "proof") body.quote.inputs_sha256 = imageLedHash("historical-B04");
  await expect(imageLedAction("world", routeId, body)).rejects.toMatchObject({ status: 409 });
  expect(tables.get("image_led_walk_steps")?.size ?? 0).toBe(0); expect(state.reserve).not.toHaveBeenCalled();
});
it("fences source metadata in the generation transaction before reserving spend", async () => {
  await createImageLedWalk("world", createBody()); const body = await scheduleBody(); state.fence.mockRejectedValueOnce(new CreatorError("Landmark identity changed", 409));
  await expect(imageLedAction("world", routeId, body)).rejects.toMatchObject({ status: 409 }); expect(state.reserve).not.toHaveBeenCalled();
});
it("invalidates an unsent quote after a model switch before reserving or writing a job", async () => {
  await createImageLedWalk("world", createBody()); const body = await scheduleBody();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, profile: "image-led-v1", model: "openai/gpt-image-2.5/sunburst/edit", parameters: IMAGE_LED_STILL_PROFILES["openai/gpt-image-2.5/sunburst/edit"].parameters, reservation }))));
  await expect(imageLedAction("world", routeId, body)).rejects.toMatchObject({ status: 409 });
  expect(state.reserve).not.toHaveBeenCalled(); expect(tables.get("image_led_walk_steps")?.size ?? 0).toBe(0);
});
it("replays an already claimed UUID without querying the switched model or reserving again", async () => {
  await createImageLedWalk("world", createBody()); const body = await scheduleBody(); await imageLedAction("world", routeId, body);
  vi.mocked(fetch).mockClear(); vi.mocked(fetch).mockRejectedValue(new Error("Current profile unavailable"));
  expect((await imageLedAction("world", routeId, body)).walk.frames[0]).toMatchObject({ job_id: requestId, status: "scheduled" });
  expect(fetch).not.toHaveBeenCalled(); expect(state.reserve).toHaveBeenCalledOnce();
});
it("keeps a source rejection immutable and requires exact saved review bytes", async () => {
  await createImageLedWalk("world", createBody()); const walk = storedWalk(); walk.frames[0] = { index: 0, status: "ready", raw: image, image, review: { identity: "pending", route: "pending", spatial: "unmeasured" } };
  const body = { action: "review", kind: "still", index: 0, sha256: sha, identity: "rejected", route: "approved", notes: "Missing book bay and moth sign" };
  const result = await imageLedAction("world", routeId, body); expect(result.walk.frames[0]!.review).toMatchObject({ identity: "rejected", route: "approved", spatial: "unmeasured" });
  await expect(imageLedAction("world", routeId, { ...body, identity: "approved" })).rejects.toMatchObject({ status: 409 });
  await expect(imageLedAction("world", routeId, { ...body, sha256: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
  await expect(imageLedDetail("world", routeId, "still", 1)).resolves.toMatchObject({ quote: null }); expect(state.reserve).not.toHaveBeenCalled();
});
async function repairForkFixture() {
  await createImageLedWalk("world", createBody());
  const parent = storedWalk();
  parent.frames[0] = { index: 0, status: "ready", job_id: "original-job", raw: image, image, review: { identity: "approved", route: "approved", spatial: "unmeasured", sha256: image.sha256, reviewed_at: new Date(0).toISOString() } };
  parent.frames[1] = { index: 1, status: "ready", job_id: "rejected-job", raw: image, image, review: { identity: "rejected", route: "rejected", spatial: "unmeasured", sha256: image.sha256, reviewed_at: new Date(0).toISOString() } };
  return { action: "fork", id: aliasId, index: 1, revision: parent.revision };
}
it("forks the exact owner-approved prefix without spending, replacing rejected history or copying job claims", async () => {
  const body = await repairForkFixture(), before = structuredClone(storedWalk());
  const result = await imageLedAction("world", routeId, body);
  expect(result.walk.id).toBe(aliasId); expect(result.walk.frames[0]).toMatchObject({ image: { sha256: sha }, review: before.frames[0]!.review });
  expect(result.walk.frames[0]).not.toHaveProperty("job_id"); expect(result.walk.frames[1]).toMatchObject({ status: "empty", review: { identity: "pending", route: "pending" } });
  expect(result.walk.frames[1]).not.toHaveProperty("image"); expect(result.walk.frames[1]).not.toHaveProperty("job_id");
  expect(storedWalk().frames).toEqual(before.frames); expect(storedWalk().legs).toEqual(before.legs);
  expect(state.reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(tables.get("image_led_walk_steps")?.size ?? 0).toBe(0);
  const quote = await imageLedDetail("world", aliasId, "still", 1); expect(quote.quote).toMatchObject({ index: 1, playback: { width: 64, height: 64 } });
});
it("replays a fork once across racing requests and a changed parent without rereading or spending", async () => {
  const body = await repairForkFixture(); const beforeRevision = storedWalk().revision;
  const results = await Promise.all([imageLedAction("world", routeId, body), imageLedAction("world", routeId, body)]);
  expect(results.every(r => r.walk.id === aliasId)).toBe(true); expect(tables.get("image_led_walks")!.size).toBe(2);
  expect(storedWalk().revision).toBe(beforeRevision + 1);
  state.current.mockRejectedValue(new Error("storage offline")); state.read.mockRejectedValue(new Error("storage offline"));
  const replay = await imageLedAction("world", routeId, { revision: body.revision, index: 1, id: aliasId, action: "fork" });
  expect(replay.walk.id).toBe(aliasId); expect(state.reserve).not.toHaveBeenCalled();
  await expect(imageLedAction("world", routeId, { ...body, index: 0 })).rejects.toMatchObject({ status: 409 });
});
it.each(["review", "source", "bytes", "active", "revision", "extra", "owner"])("rejects a %s repair fork before copying content or spending", async kind => {
  const body = await repairForkFixture();
  if (kind === "review") storedWalk().frames[0]!.review.identity = "pending";
  if (kind === "source") state.current.mockRejectedValue(new CreatorError("Source changed", 409));
  if (kind === "bytes") state.read.mockRejectedValue(new CreatorError("Saved bytes changed", 409));
  if (kind === "active") storedWalk().frames[1]!.status = "submission_unknown";
  if (kind === "revision") body.revision -= 1;
  if (kind === "owner") state.owner.mockRejectedValue(new CreatorError("Not owner", 403));
  await expect(imageLedAction("world", routeId, kind === "extra" ? { ...body, confirmed: true } : body)).rejects.toMatchObject({ status: kind === "extra" ? 400 : kind === "owner" ? 403 : 409 });
  expect(tables.get("image_led_walks")!.size).toBe(1); expect(state.reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("can explicitly restart a rejected first view without carrying its old selected seed", async () => {
  const body = await repairForkFixture(); storedWalk().seed = { view_id: "old-view", asset_id: "old-asset", sha256: sha, review_sha256: sha, image };
  storedWalk().frames[0]!.review.identity = "rejected";
  const result = await imageLedAction("world", routeId, { ...body, index: 0 });
  expect(result.walk).not.toHaveProperty("seed"); expect(result.walk.frames.every(f => f.status === "empty")).toBe(true);
  expect(storedWalk().seed?.view_id).toBe("old-view"); expect(storedWalk().frames[0]!.review.identity).toBe("rejected"); expect(fetch).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled();
});
it("quotes a receipted rejected target on the new fork while keeping the actual reviewed predecessor", async () => {
  const body = await repairForkFixture(), parent = storedWalk();
  const target = { ...image, key: `world/image-led/${routeId}/rejected.png` }; parent.frames[1]!.raw = target;
  tables.set("image_led_walk_steps", new Map([["world:rejected-job", { _id: "world:rejected-job", session_id: "world", walk_id: routeId, kind: "still", index: 1, original: target, quote: { source_sha256: parent.source.image.sha256, binding_sha256: parent.source.binding_sha256, route_sha256: parent.route.sha256 } }]]));
  await imageLedAction("world", routeId, body);
  const repair = { checkpoint_index: 1, source_sha256: sha, target_sha256: target.sha256, image: target };
  const result = await imageLedAction("world", aliasId, { action: "quote", kind: "still", index: 1, repair });
  expect(result).toMatchObject({ quote: { repair }, walk: { frames: [{ image: { sha256: sha }, review: { identity: "approved", route: "approved" } }, { status: "empty" }] } });
  expect(state.read.mock.calls.some(([key]) => key === target.key)).toBe(true); expect(state.read.mock.calls.some(([key]) => key === parent.frames[0]!.image!.key)).toBe(true);
  expect(parent.frames[1]!.raw).toEqual(target); expect(parent.frames[1]!.review.identity).toBe("rejected"); expect(state.reserve).not.toHaveBeenCalled();
  expect(tables.get("image_led_walk_steps")!.size).toBe(1);
});
it("fences a changed parent review inside the fork transaction", async () => {
  const body = await repairForkFixture(); state.fence.mockImplementationOnce(async () => { storedWalk().revision += 1; });
  await expect(imageLedAction("world", routeId, body)).rejects.toMatchObject({ status: 409 });
  expect(tables.get("image_led_walks")!.size).toBe(1); expect(state.reserve).not.toHaveBeenCalled();
});
async function clipPrefixFixture() {
  const body = await repairForkFixture(), parent = storedWalk();
  const second = { ...image, key: "world/frame-1.png", sha256: "e".repeat(64) };
  parent.frames[1]!.raw = second; parent.frames[1]!.image = second; parent.frames[1]!.review = { ...structuredClone(parent.frames[0]!.review), sha256: second.sha256 };
  parent.frames.push({ index: 2, status: "ready", raw: image, image, review: { identity: "rejected", route: "rejected", spatial: "unmeasured", sha256: sha, reviewed_at: new Date(0).toISOString() } });
  parent.route = imageLedRoute([...parent.route.points, { x: .5, y: .5 }], sha);
  const original = { key: "world/image-led/old/original.mp4", bytes: 10, sha256: "c".repeat(64), content_type: "video/mp4" as const }, video = { ...original, key: "world/image-led/old/silent.mp4", sha256: "d".repeat(64) };
  parent.legs = [{ index: 0, from: 0, to: 1, status: "ready", job_id: "paid-video-job", original, video, review: { temporal: "approved", sha256: video.sha256, reviewed_at: new Date(0).toISOString() } }, { index: 1, from: 1, to: 2, status: "empty", review: { temporal: "pending" } }];
  return { ...body, index: 2 };
}
it.each(["approved", "pending"] as const)("preserves an existing %s clip inside the exact copied prefix without copying its job or approving it", async temporal => {
  const body = await clipPrefixFixture(); if (temporal === "pending") storedWalk().legs[0]!.review = { temporal };
  const before = structuredClone(storedWalk().legs[0]); const result = await imageLedAction("world", routeId, body);
  expect(result.walk.legs[0]).toMatchObject({ original: { sha256: before!.original!.sha256 }, video: { sha256: before!.video!.sha256 }, review: before!.review });
  expect(result.walk.legs[0]).not.toHaveProperty("job_id"); expect(result.walk.legs[1]!.status).toBe("empty");
  expect(state.verify).toHaveBeenCalledTimes(2); expect(storedWalk().legs[0]).toEqual(before); expect(state.reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("blocks a fork when a preserved clip has missing or changed bytes", async () => {
  const body = await clipPrefixFixture(); state.verify.mockResolvedValue(null);
  await expect(imageLedAction("world", routeId, body)).rejects.toMatchObject({ status: 503 });
  expect(tables.get("image_led_walks")!.size).toBe(1); expect(state.reserve).not.toHaveBeenCalled();
});
