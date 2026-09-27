import { beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, Document>>(), owner: true, tail: Promise.resolve(), failFinalization: false, failAppearance: false }));
const store = (name: string) => { if (!memory.rows.has(name)) memory.rows.set(name, new Map()); return memory.rows.get(name)!; };
function collection(name: string) {
  const matches = (row: Document, query: Document) => Object.entries(query).every(([k, v]) => v && typeof v === "object" && "$in" in v ? v.$in.includes(row[k]) : v && typeof v === "object" && "$lt" in v ? row[k] < v.$lt : v && typeof v === "object" && "$gt" in v ? row[k] > v.$gt : v && typeof v === "object" && "$exists" in v ? (k in row) === v.$exists : row[k] === v);
  const find = (query: Document) => [...store(name).values()].filter(row => matches(row, query));
  const update = (row: Document, change: Document) => { Object.assign(row, change.$set); for (const [k, v] of Object.entries(change.$inc ?? {})) row[k] = (row[k] ?? 0) + Number(v); for (const k of Object.keys(change.$unset ?? {})) delete row[k]; };
  return {
    findOne: async (query: Document) => structuredClone(find(query)[0] ?? null),
    findOneAndUpdate: async (query: Document, change: Document) => { const row = find(query)[0]; if (!row) return null; update(row, change); return structuredClone(row); },
    find: (query: Document) => { const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => structuredClone(find(query)) }; return cursor; },
    insertOne: async (row: Document) => { if (store(name).has(row._id)) throw new Error("duplicate"); store(name).set(row._id, structuredClone(row)); },
    updateOne: async (query: Document, change: Document, options: Document = {}) => {
      if (memory.failFinalization && change.$set?.status === "ready") throw new Error("Storage unavailable after provider receipt");
      if (memory.failAppearance && change.$set?.appearance_approval) throw new Error("Approval storage failed");
      let row = find(query)[0]; if (!row && options.upsert) { row = { _id: query._id }; store(name).set(row._id, row); } if (row) update(row, change);
    },
    updateMany: async (query: Document, change: Document) => { for (const row of find(query)) update(row, change); },
  };
}
vi.mock("./db", () => ({ withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>) => {
  const previous = memory.tail; let release!: () => void; memory.tail = new Promise<void>(resolve => { release = resolve; }); await previous;
  const before = structuredClone(memory.rows);
  try { return await run({ collection } as unknown as Db, {} as ClientSession); } catch (e) { memory.rows = before; throw e; } finally { release(); }
} }));
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => { if (!memory.owner) throw Object.assign(new Error("Not owner"), { status: 403 }); return { collection }; } }));
vi.mock("./place-scene-server", () => ({ sceneKey: (sid: string, pid: string) => `${sid}:${pid}`, previewPlaceScene: vi.fn() }));
vi.mock("./place-scene-enabled", () => ({ placeScenesEnabled: () => true }));
import { emptyPlaceScene, newComponent } from "./place-scene";
import { queuePlaceBuild, runPlaceBuild, cancelPlaceBuild, placeBuildLibrary, previewPlaceBuild, revalidatePlaceBuild } from "./place-build-server";
import { previewPlaceScene } from "./place-scene-server";
import { claimPlaceBuild, executePlaceBuild, finalizePlaceBuild, processNextPlaceBuild, type BuildDoc } from "./place-build-execution";
import { queueBuildMaterials, replaceBuildMaterial, cancelBuildMaterials, refreshBuildMaterial, materialBuildDefinition, queueBuildAssets, replaceBuildAsset, cancelBuildAssets, refreshBuildAsset, readBuildAssetStage, assetBuildDefinition, queueBuildAppearance } from "./place-build-assets-server";
import { MATERIAL_MODEL } from "./asset-pipeline";
import { MESH_MODEL } from "./mesh-asset";
import { connectionInputHash, readBuildConnections } from "./place-build-connections";
const db = { collection } as unknown as Db;
async function runAndWork() {
  await runPlaceBuild("world", "place", "job1");
  await processNextPlaceBuild(db);
  return { job: store("place_build_jobs").get("world:place:job1")! };
}
const provider = vi.fn(), input = { id: "job1", prompt: "A pair of workshops", confirmed: true, reservation: 0.2, model: "test-model", base_revision: 1 };
const planCalls = () => provider.mock.calls.filter(([url]) => url.endsWith("/plan"));
beforeEach(() => {
  memory.rows.clear(); memory.owner = true; memory.tail = Promise.resolve(); memory.failFinalization = false; memory.failAppearance = false; provider.mockReset(); vi.stubGlobal("fetch", provider);
  vi.stubEnv("MODAL_API_URL", "https://backend.test"); vi.stubEnv("PLACE_BUILD_DAILY_CAP_USD", "1"); vi.stubEnv("MAX_DAILY_SPEND", "0"); vi.stubEnv("MAX_SESSION_SPEND", "0");
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1, definition: emptyPlaceScene() });
  store("generation_workers").set("worker", { _id: "worker", kind: "place-layout", layout_connections: true, layout_floor_targets: true, last_seen: new Date() });
  provider.mockImplementation(async (url: string) => Response.json(url.endsWith("capabilities") ? { enabled: true, model: "test-model", reservation: 0.2, connection_context_version: 1, floor_target_version: 1 } : { status: "ready", model: "test-model", request_id: "provider-job", result: { objects: [newComponent("building", 20, 15)] } }));
});
function furnishInput() {
  const building = newComponent("building", 20, 15); building.height = 7.8;
  building.structure!.floors.push({ id: "upper", label: "Upper" });
  store("place_scenes").get("world:place")!.definition.objects.push(building);
  return { ...input, target_floor: { building_id: building.id, floor_id: "upper" } };
}
it("revalidates saved rejected output without provider calls, reservations or scene writes", async () => {
  await queuePlaceBuild("world", "place", input); await runAndWork();
  const saved = store("place_build_jobs").get("world:place:job1")!;
  saved.status = "invalid"; saved.error = "Earlier validator rejected output"; delete saved.result;
  const response = structuredClone(saved.provider_response), ledger = structuredClone(store("spend_ledger")), scenes = structuredClone(store("place_scenes"));
  const calls = provider.mock.calls.length;
  expect((await revalidatePlaceBuild("world", "place", "job1")).job.status).toBe("validating");
  expect((await revalidatePlaceBuild("world", "place", "job1")).job.status).toBe("validating");
  await processNextPlaceBuild(db);
  expect(store("place_build_jobs").get("world:place:job1")!.status).toBe("ready");
  expect((await revalidatePlaceBuild("world", "place", "job1")).job.status).toBe("ready");
  expect(provider.mock.calls).toHaveLength(calls); expect(store("spend_ledger")).toEqual(ledger); expect(store("place_scenes")).toEqual(scenes);
  expect(store("place_build_jobs").get("world:place:job1")!.provider_response).toEqual(response);
});
it("refuses stale, cancelled, incomplete and cross-owner revalidation", async () => {
  await queuePlaceBuild("world", "place", input); await runAndWork();
  const saved = store("place_build_jobs").get("world:place:job1")!;
  saved.status = "invalid";
  memory.owner = false; await expect(revalidatePlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 403 }); memory.owner = true;
  store("place_scenes").get("world:place")!.revision = 2;
  await expect(revalidatePlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 409 });
  store("place_scenes").get("world:place")!.revision = 1;
  store("place_build_jobs").get("world:place:job1")!.provider_response = { status: "invalid" };
  await expect(revalidatePlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 409 });
  store("place_build_jobs").get("world:place:job1")!.status = "cancelled";
  await expect(revalidatePlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 409 });
  expect(planCalls()).toHaveLength(1);
});
it("pins a saved floor in consent, provider input, result and receipt without extra calls", async () => {
  const request = furnishInput(), before = structuredClone(store("place_scenes").get("world:place")!.definition);
  const original = provider.getMockImplementation()!;
  provider.mockImplementation(async (url: string, options) => url.endsWith("/plan") ? Response.json({ status: "ready", model: "test-model", request_id: "furniture", result: { objects: [{ ...newComponent("volume", 2, 2), width: 0.8, depth: 0.8, height: 1, placement: request.target_floor }] } }) : original(url, options));
  expect((await queuePlaceBuild("world", "place", request)).job.target_floor).toEqual(request.target_floor);
  await expect(queuePlaceBuild("world", "place", input)).rejects.toMatchObject({ status: 409 });
  await expect(queuePlaceBuild("world", "place", { ...request, target_floor: { ...request.target_floor, floor_id: "elsewhere" } })).rejects.toMatchObject({ status: 409 });
  const { job } = await runAndWork();
  expect(job.status).toBe("ready"); expect(job.receipt.target_floor).toEqual(request.target_floor);
  expect(JSON.parse(planCalls()[0]![1].body).target_floor).toEqual(request.target_floor);
  expect(job.result.objects[0]).toEqual(before.objects[0]); expect(job.result.objects[1].placement).toEqual(request.target_floor);
  await queuePlaceBuild("world", "place", request); await placeBuildLibrary("world", "place");
  expect(planCalls()).toHaveLength(1); expect(store("place_scenes").get("world:place")!.definition).toEqual(before);
});
it("rejects a model result outside the reserved floor instead of relocating it silently", async () => {
  const request = furnishInput(); await queuePlaceBuild("world", "place", request);
  const { job } = await runAndWork(); expect(job.status).toBe("invalid"); expect(job.error).toContain("selected saved floor");
  expect(job.result).toBeUndefined(); expect(planCalls()).toHaveLength(1);
});
it("cancels and refunds a scheduled furnishing request when its saved floor is removed", async () => {
  const request = furnishInput(); await queuePlaceBuild("world", "place", request); await runPlaceBuild("world", "place", "job1");
  store("place_scenes").get("world:place")!.definition.objects[0].structure.floors.pop();
  await processNextPlaceBuild(db); await processNextPlaceBuild(db);
  expect(store("place_build_jobs").get("world:place:job1")!.status).toBe("cancelled");
  expect([...store("spend_ledger").values()].every(row => row.total === 0)).toBe(true);
  expect(planCalls()).toHaveLength(0);
});
it("rejects malformed, missing and foreign floor targets without reserving funds", async () => {
  const request = furnishInput();
  for (const target_floor of [null, {}, [], { ...request.target_floor, room_id: "extra" }, { building_id: "../bad", floor_id: "upper" }]) await expect(queuePlaceBuild("world", "place", { ...request, target_floor })).rejects.toMatchObject({ status: 400 });
  for (const target_floor of [{ ...request.target_floor, floor_id: "missing" }, { building_id: "foreign", floor_id: "upper" }]) await expect(queuePlaceBuild("world", "place", { ...request, target_floor })).rejects.toMatchObject({ status: 409 });
  expect(store("spend_ledger").size).toBe(0); expect(store("place_build_jobs").size).toBe(0); expect(planCalls()).toHaveLength(0);
});
it("disables scoped generation with old backends or any old worker, retaining whole-place compatibility", async () => {
  const request = furnishInput();
  store("generation_workers").set("old", { _id: "old", kind: "place-layout", last_seen: new Date() });
  await expect(queuePlaceBuild("world", "place", request)).rejects.toMatchObject({ status: 503 });
  expect((await placeBuildLibrary("world", "place")).capabilities.floor_target_version).toBe(0);
  store("generation_workers").delete("old");
  provider.mockResolvedValue(Response.json({ enabled: true, model: "test-model", reservation: 0.2 }));
  await expect(queuePlaceBuild("world", "place", request)).rejects.toMatchObject({ status: 503 });
  expect(store("spend_ledger").size).toBe(0);
});
function connect(id = "road", side = "east") {
  const row = { _id: `world:${id}`, session_id: "world", id, version: 1, kind: "boundary", width: 4, created_at: "2026-09-13",
    a: { place_id: "place", side, offset: 20 }, b: { place_id: "neighbor", side: side === "east" ? "west" : "south", offset: 20 } };
  store("place_connections").set(row._id, row); return row;
}
it("freezes scoped connection inputs and sends the exact snapshot once, retaining receipt provenance", async () => {
  connect("z"); connect("a", "north");
  store("place_connections").set("foreign", { ...connect("other"), _id: "foreign", session_id: "foreign" }); store("place_connections").delete("world:other");
  await queuePlaceBuild("world", "place", input); const frozen = structuredClone(store("place_build_jobs").get("world:place:job1")!);
  expect(frozen.connection_input.connections.map((c: Document) => c.id)).toEqual(["a", "z"]);
  expect(frozen.connections_sha256).toBe(connectionInputHash(frozen.connection_input));
  const { job } = await runAndWork(); expect(job.status).toBe("ready");
  expect(JSON.parse(planCalls()[0]![1].body).connection_input).toEqual(frozen.connection_input);
  expect(job.receipt).toMatchObject({ connection_input: frozen.connection_input, connections_sha256: frozen.connections_sha256 });
  expect(await queuePlaceBuild("world", "place", input)).toMatchObject({ job: { id: "job1" } }); expect(planCalls()).toHaveLength(1);
});
it("does not reserve connected work with old workers or a backend lacking the context contract", async () => {
  connect(); delete store("generation_workers").get("worker")!.layout_connections;
  await expect(queuePlaceBuild("world", "place", input)).rejects.toMatchObject({ status: 503 });
  store("generation_workers").get("worker")!.layout_connections = true;
  store("generation_workers").set("old", { _id: "old", kind: "place-layout", last_seen: new Date() });
  await expect(queuePlaceBuild("world", "place", input)).rejects.toMatchObject({ status: 503 }); store("generation_workers").delete("old");
  provider.mockResolvedValue(Response.json({ enabled: true, model: "test-model", reservation: 0.2 }));
  await expect(queuePlaceBuild("world", "place", input)).rejects.toMatchObject({ status: 503 });
  expect(store("place_build_jobs").size).toBe(0); expect(store("spend_ledger").size).toBe(0); expect(planCalls()).toHaveLength(0);
});
it("rejects changed queued links and refunds a stale scheduled build exactly once before calling the model", async () => {
  const road = connect(); await queuePlaceBuild("world", "place", input); road.width = 5;
  await expect(runPlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 409 });
  store("place_connections").get("world:road")!.width = 4; await runPlaceBuild("world", "place", "job1");
  store("place_connections").get("world:road")!.b.offset = 22;
  expect(await claimPlaceBuild()).toBeNull(); expect(await claimPlaceBuild()).toBeNull();
  expect(store("place_build_jobs").get("world:place:job1")!.status).toBe("cancelled"); expect(planCalls()).toHaveLength(0);
  expect([...store("spend_ledger").values()].every(v => Math.abs(v.total) < 1e-8)).toBe(true);
});
it("retains known results but refuses stale connected previews and new dependent asset reservations", async () => {
  const build = await materialBuild(true); connect();
  await expect(previewPlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 409 });
  await expect(previewPlaceBuild("world", "place", "job1", true)).rejects.toMatchObject({ status: 409 });
  await expect(queueBuildMaterials("world", "place", "job1", materialRequest)).rejects.toMatchObject({ status: 409 });
  await expect(queueBuildAssets("world", "place", "job1", meshRequest, "mesh")).rejects.toMatchObject({ status: 409 });
  expect(store("material_jobs").size).toBe(0); expect(store("mesh_jobs").size).toBe(0); expect(build.status).toBe("ready"); expect(planCalls()).toHaveLength(1);
});
it("preserves connection ordering deterministically and rejects legacy connected jobs without rebasing", async () => {
  await queuePlaceBuild("world", "place", input); const legacy = store("place_build_jobs").get("world:place:job1")!; delete legacy.connection_input; delete legacy.connections_sha256;
  connect(); await expect(runPlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 409 });
  store("place_connections").clear(); await expect(runPlaceBuild("world", "place", "job1")).resolves.toMatchObject({ job: { status: "scheduled" } });
  const first = connect("z"), second = connect("a", "north"), snapshot = await readBuildConnections(db, "world", "place");
  store("place_connections").clear(); store("place_connections").set(second._id, second); store("place_connections").set(first._id, first);
  expect(await readBuildConnections(db, "world", "place")).toEqual(snapshot);
});
const materialQuote = { model: MATERIAL_MODEL, reservation: 0.1, parameters: { prompt_version: "test-tile" } };
const materialRequest = { ...materialQuote, request_id: "batch1", confirmed: true };
const meshQuote = { model: MESH_MODEL, reservation: 2, parameters: { fixture: "mesh" } };
const meshRequest = { ...meshQuote, request_id: "mesh-batch1", confirmed: true };
async function materialBuild(withMeshes = false) {
  const object = newComponent("building", 20, 15);
  const volumes = withMeshes ? [newComponent("volume", 8, 30), newComponent("volume", 30, 30)] : [];
  const meshes = volumes.map((o, i) => ({ id: `exterior${i}`, prompt: `Carved stone pavilion ${i}`, role: "exterior", targets: [{ object_id: o.id }] }));
  const materials = ["wall", "roof"].map(surface => ({ id: surface, prompt: `Weathered ${surface} surface`, targets: [{ object_id: object.id, surface, tile_metres: 2, rotation: 0, roughness: 0.8 }] }));
  store("generation_workers").get("worker")!.material = true;
  store("generation_workers").get("worker")!.mesh = true; vi.stubEnv("MESH_DAILY_CAP_USD", "4");
  vi.stubEnv("MATERIAL_DAILY_CAP_USD", "4");
  provider.mockImplementation(async (url: string) => Response.json(url.includes("/mesh/") ? { enabled: true, ...meshQuote } : url.includes("/material/") ? { enabled: true, ...materialQuote }
    : url.endsWith("capabilities") ? { enabled: true, model: "test-model", reservation: 0.2 }
    : { status: "ready", model: "test-model", result: { objects: [object, ...volumes], materials, ...(withMeshes ? { meshes } : {}) } }));
  await queuePlaceBuild("world", "place", input); await runAndWork();
  return store("place_build_jobs").get("world:place:job1")! as BuildDoc;
}
const materialStage = () => store("place_build_assets").get("world:place:job1")!;
const appearanceRequest = { request_id: "appearance1", confirmed: true, total_reservation: 4.2, quotes: { material: materialQuote, mesh: meshQuote } };
const appearance = (body: Record<string, unknown> = appearanceRequest) => queueBuildAppearance("world", "place", "job1", body);
const records = () => structuredClone(new Map([...memory.rows].filter(([, rows]) => rows.size)));
it("reserves all appearance once with a durable parent approval and shared immutable child dependencies", async () => {
  const build = await materialBuild(true), result = structuredClone(build.result);
  const [a, b] = await Promise.all([appearance(), appearance()]); expect(a).toEqual(b);
  expect(store("material_jobs").size).toBe(2); expect(store("mesh_jobs").size).toBe(2); expect(store("place_build_assets").size).toBe(2);
  const approval = store("place_build_jobs").get(build._id)!.appearance_approval;
  expect(approval).toEqual({ id: "appearance1", kinds: ["material", "mesh"], total_reservation: 4.2, quotes: appearanceRequest.quotes });
  for (const kind of ["material", "mesh"]) for (const job of store(`${kind}_jobs`).values()) expect(job).toMatchObject({ status: "scheduled", dependency: { kind, build_key: build._id, result_sha256: expect.any(String) } });
  expect((await placeBuildLibrary("world", "place")).jobs[0]!.appearance_approval).toEqual({ id: "appearance1", kinds: ["material", "mesh"], total_reservation: 4.2 });
  expect(store("spend_ledger").get(`sess:world:${new Date().toISOString().slice(0, 10)}`)!.total).toBeCloseTo(4.4); expect(build.result).toEqual(result);
  expect(provider.mock.calls.filter(([url]) => url.endsWith("/submit"))).toHaveLength(0);
});
it("replays appearance offline after cancellation without another reservation or reactivation", async () => {
  await materialBuild(true); await appearance(); await cancelBuildAssets("world", "place", "job1", "mesh");
  const before = records(); provider.mockRejectedValue(new Error("offline")); expect(await appearance()).toMatchObject({ reservation: 4.2 }); expect(records()).toEqual(before);
  expect([...store("mesh_jobs").values()].every(j => j.status === "cancelled")).toBe(true); expect([...store("material_jobs").values()].every(j => j.status === "scheduled")).toBe(true);
});
it.each(["budget", "approval-write"])("rolls back both appearance stages and every ledger on %s failure", async failure => {
  await materialBuild(true); const before = records();
  if(failure==="budget")vi.stubEnv("MESH_DAILY_CAP_USD", "3");else memory.failAppearance = true;
  await expect(appearance()).rejects.toThrow(failure === "budget" ? "spend cap" : "Approval storage failed"); expect(records()).toEqual(before);
});
it.each([false,true])("never recreates missing approved stage records (all missing: %s)",async all=>{
  const build=await materialBuild(true);await appearance();store("place_build_assets").delete("world:place:job1:mesh");if(all)store("place_build_assets").clear();
  const before=records();provider.mockRejectedValue(new Error("offline"));
  await expect(appearance()).rejects.toMatchObject({status:409});await expect(appearance({...appearanceRequest,request_id:"new-id"})).rejects.toMatchObject({status:409});
  await expect(assetBuildDefinition(db,build,"mesh")).rejects.toThrow("stage is missing");expect(records()).toEqual(before);
});
it("rejects underquoted, omitted and changed appearance inputs without partial jobs", async () => {
  await materialBuild(true); const before = records();
  await expect(appearance({ ...appearanceRequest, total_reservation: 0.2 })).rejects.toMatchObject({ status: 409 });
  await expect(appearance({ ...appearanceRequest, quotes: { material: materialQuote }, total_reservation: 0.2 })).rejects.toMatchObject({ status: 409 });
  await expect(appearance({ ...appearanceRequest, quotes: { ...appearanceRequest.quotes, mesh: { ...meshQuote, parameters: {} } } })).rejects.toMatchObject({ status: 409 }); expect(records()).toEqual(before);
  await appearance(); const saved = records(); await expect(appearance({ ...appearanceRequest, total_reservation: 4.3 })).rejects.toMatchObject({ status: 409 }); expect(records()).toEqual(saved);
});
it("generates only the remaining stage beside a previously approved independent batch", async () => {
  const build=await materialBuild(true); await queueBuildMaterials("world", "place", "job1", materialRequest);
  const material = structuredClone(materialStage()); await appearance({ ...appearanceRequest, quotes: { mesh: meshQuote }, total_reservation: 4 });
  expect(materialStage()).toEqual(material); expect(store("material_jobs").size).toBe(2); expect(store("mesh_jobs").size).toBe(2);
  expect(store("place_build_jobs").get("world:place:job1")!.appearance_approval.kinds).toEqual(["mesh"]);
  store("place_build_assets").delete("world:place:job1");await expect(assetBuildDefinition(db,build,"material")).rejects.toThrow("stage is missing");
});
it("serializes a combined approval racing an independent material batch", async () => {
  await materialBuild(true); const results = await Promise.allSettled([appearance(), queueBuildMaterials("world", "place", "job1", materialRequest)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  expect(store("material_jobs").size).toBe(2); expect(store("mesh_jobs").size).toBe(results[0]!.status === "fulfilled" ? 2 : 0);
  expect(store("place_build_assets").size).toBe(results[0]!.status === "fulfilled" ? 2 : 1);
});
it("checks appearance ownership, explicit consent, quote kinds and stale connections", async () => {
  await materialBuild(true); provider.mockClear(); memory.owner=false;await expect(appearance()).rejects.toMatchObject({status:403});memory.owner=true;
  for(const patch of [{confirmed:false},{quotes:{}},{quotes:{illustration:materialQuote}},{quotes:{mesh:null}},{quotes:{mesh:{...meshQuote,model:"image-mesh"}}}])await expect(appearance({...appearanceRequest,...patch})).rejects.toMatchObject({status:400});
  expect(provider).not.toHaveBeenCalled();connect();const before=records();await expect(appearance()).rejects.toMatchObject({status:409});expect(records()).toEqual(before);
});
it("keeps mesh and material stages separate while sharing atomic budgets and layout identity", async () => {
  const build = await materialBuild(true); expect(build.mesh_plan).toHaveLength(2);
  await queueBuildMaterials("world", "place", "job1", materialRequest);
  await Promise.all([queueBuildAssets("world", "place", "job1", meshRequest, "mesh"), queueBuildAssets("world", "place", "job1", meshRequest, "mesh")]);
  expect(store("place_build_assets").size).toBe(2); expect(store("mesh_jobs").size).toBe(2); expect(store("material_jobs").size).toBe(2);
  for (const j of store("mesh_jobs").values()) expect(j.dependency).toMatchObject({ kind: "mesh", build_key: build._id });
  expect(store("spend_ledger").get(`sess:world:${new Date().toISOString().slice(0, 10)}`)!.total).toBeCloseTo(4.4);
  delete materialStage().kind;
  expect((await readBuildAssetStage(db, build, "material"))!.status).toBe("generating");
  expect((await readBuildAssetStage(db, build, "mesh"))!.items).toHaveLength(2);
  expect((await placeBuildLibrary("world", "place")).jobs[0]!.mesh_plan).toEqual(build.mesh_plan);
  expect(planCalls()).toHaveLength(1); expect(provider.mock.calls.filter(([url]) => url.endsWith("/submit"))).toHaveLength(0);
});
it("rolls back an over-budget mesh batch without discarding the accepted layout or material stage", async () => {
  await materialBuild(true); await queueBuildMaterials("world", "place", "job1", materialRequest); vi.stubEnv("MAX_SESSION_SPEND", "3");
  await expect(queueBuildAssets("world", "place", "job1", meshRequest, "mesh")).rejects.toMatchObject({ status: 429 });
  expect(store("mesh_jobs").size).toBe(0); expect(store("material_jobs").size).toBe(2); expect(store("place_build_assets").size).toBe(1);
  expect(store("spend_ledger").get(`sess:world:${new Date().toISOString().slice(0, 10)}`)!.total).toBeCloseTo(0.4);
});
it("assembles both stages using measured bounds, preserving building structure and mesh roles", async () => {
  const build = await materialBuild(true), original = structuredClone(build.result);
  await queueBuildMaterials("world", "place", "job1", materialRequest); await queueBuildAssets("world", "place", "job1", meshRequest, "mesh");
  for (const kind of ["material", "mesh"]) for (const row of store(`${kind}_jobs`).values()) {
    row.status = "ready"; row.asset_id = `${kind}_${row.id}`;
    store(`${kind}_assets`).set(`world:${row.asset_id}`, { _id: `world:${row.asset_id}`, id: row.asset_id, session_id: "world", sha256: "verified",
      ...(kind === "material" ? { image: { channel: "base_color" } } : { geometry: { sha256: "verified", size: { width: 2, height: 4, depth: 3 } } }) });
  }
  await previewPlaceBuild("world", "place", "job1");
  const definition = vi.mocked(previewPlaceScene).mock.lastCall![2].definition as NonNullable<BuildDoc["result"]>;
  expect(definition.objects[0]!.structure).toEqual(original!.objects[0]!.structure); expect(definition.objects[0]!.materials?.wall).toBeDefined();
  for (const object of definition.objects.slice(1)) expect(object).toMatchObject({ kind: "mesh", mesh_role: "exterior", mesh_scale: "uniform", width: 1.5, height: 3, depth: 2.25 });
  expect(build.result).toEqual(original); expect(definition.objects.map(o => o.id)).toEqual(original!.objects.map(o => o.id));
  store("mesh_assets").clear(); await expect(assetBuildDefinition(db, build, "mesh")).rejects.toMatchObject({ status: 404 });
});
it("replaces only a failed mesh, records the parent build key, and rejects foreign dependency actions", async () => {
  await materialBuild(true); await queueBuildAssets("world", "place", "job1", meshRequest, "mesh");
  const stage = store("place_build_assets").get("world:place:job1:mesh")!, first = store("mesh_jobs").get(`world:${stage.items[0].job_id}`)!, sibling = stage.items[1].job_id;
  first.status = "failed"; vi.stubEnv("MESH_DAILY_CAP_USD", "8");
  const request = { ...meshRequest, request_id: "replace1", plan_id: stage.items[0].plan_id };
  const replaced = await replaceBuildAsset("world", "place", "job1", request, "mesh");
  expect(await replaceBuildAsset("world", "place", "job1", request, "mesh")).toEqual(replaced);
  expect(store("mesh_jobs").size).toBe(3); expect(stage.items[1].job_id).toBe(sibling);
  expect(store("mesh_jobs").get(`world:${replaced.job_id}`)!.dependency.build_key).toBe("world:place:job1");
  await expect(refreshBuildAsset("world", "place", "job1", "foreign", "mesh")).rejects.toMatchObject({ status: 404 });
  memory.owner = false; await expect(cancelBuildAssets("world", "place", "job1", "mesh")).rejects.toMatchObject({ status: 403 });
});
it("cancels a mesh batch without cancelling material siblings or refunding claimed work", async () => {
  const build = await materialBuild(true); await queueBuildMaterials("world", "place", "job1", materialRequest); await queueBuildAssets("world", "place", "job1", meshRequest, "mesh");
  [...store("mesh_jobs").values()][0]!.status = "submitting";
  await cancelBuildAssets("world", "place", "job1", "mesh"); await cancelBuildAssets("world", "place", "job1", "mesh");
  expect((await readBuildAssetStage(db, build, "mesh"))!.status).toBe("cancelled");
  expect([...store("material_jobs").values()].every(j => j.status === "scheduled")).toBe(true);
  expect(store("spend_ledger").get(`sess:world:${new Date().toISOString().slice(0, 10)}`)!.total).toBeCloseTo(2.4);
});
it("material stages require ownership and consent before provider access", async () => {
  memory.owner = false;
  for (const action of [() => queueBuildMaterials("world", "place", "job1", materialRequest), () => replaceBuildMaterial("world", "place", "job1", materialRequest), () => cancelBuildMaterials("world", "place", "job1"), () => refreshBuildMaterial("world", "place", "job1", "child")]) await expect(action()).rejects.toMatchObject({ status: 403 });
  expect(provider).not.toHaveBeenCalled(); memory.owner = true;
  await expect(queueBuildMaterials("world", "place", "job1", { ...materialRequest, confirmed: false })).rejects.toMatchObject({ status: 400 });
  expect(provider).not.toHaveBeenCalled();
});
it("atomically reserves a material batch once and binds immutable layout dependencies", async () => {
  const build = await materialBuild();
  expect(build.material_plan).toHaveLength(2);
  await Promise.all([queueBuildMaterials("world", "place", "job1", materialRequest), queueBuildMaterials("world", "place", "job1", materialRequest)]);
  expect(store("material_jobs").size).toBe(2); expect(store("place_build_assets").size).toBe(1);
  const jobs = [...store("material_jobs").values()];
  expect(jobs.every(j => j.status === "scheduled" && j.dependency.build_key === build._id && j.dependency.input_sha256 === build.input_sha256)).toBe(true);
  expect(store("spend_ledger").get(`sess:world:${new Date().toISOString().slice(0, 10)}`)!.total).toBeCloseTo(0.4);
  await placeBuildLibrary("world", "place"); expect(provider.mock.calls.filter(([url]) => url.endsWith("/submit"))).toHaveLength(0);
  provider.mockRejectedValue(new Error("offline"));
  await expect(queueBuildMaterials("world", "place", "job1", materialRequest)).resolves.toEqual({ stage_id: "batch1" });
  await expect(queueBuildMaterials("world", "place", "job1", { ...materialRequest, request_id: "different" })).rejects.toMatchObject({ status: 409 });
});
it("rolls back every child and ledger when the complete batch exceeds the shared budget", async () => {
  await materialBuild(); vi.stubEnv("MAX_SESSION_SPEND", "0.35");
  await expect(queueBuildMaterials("world", "place", "job1", materialRequest)).rejects.toMatchObject({ status: 429 });
  expect(store("material_jobs").size).toBe(0); expect(store("place_build_assets").size).toBe(0);
  expect(store("spend_ledger").get(`sess:world:${new Date().toISOString().slice(0, 10)}`)!.total).toBeCloseTo(0.2);
});
it("rejects obsolete source geometry and changed material quotes before scheduling assets", async () => {
  await materialBuild();
  await expect(queueBuildMaterials("world", "place", "job1", { ...materialRequest, parameters: {} })).rejects.toMatchObject({ status: 409 });
  store("place_scenes").get("world:place")!.definition.label = "changed without revision";
  await expect(queueBuildMaterials("world", "place", "job1", materialRequest)).rejects.toMatchObject({ status: 409 });
  expect(store("material_jobs").size).toBe(0);
});
it("assembles a textured preview only from all ready owned dependencies, keeping layout immutable", async () => {
  const build = await materialBuild(), original = structuredClone(build.result);
  await queueBuildMaterials("world", "place", "job1", materialRequest);
  await expect(materialBuildDefinition(db, build)).rejects.toMatchObject({ status: 409 });
  for (const row of store("material_jobs").values()) {
    row.status = "ready"; row.asset_id = `material_${row.id}`;
    store("material_assets").set(`world:${row.asset_id}`, { _id: `world:${row.asset_id}`, id: row.asset_id, session_id: "world", image: { channel: "base_color" } });
  }
  const bound = await materialBuildDefinition(db, build);
  expect(Object.keys(bound.objects[0]!.materials!)).toEqual(["wall", "roof"]);
  const { materials: _materials, ...geometry } = bound.objects[0]!;
  expect(geometry).toEqual(original!.objects[0]); expect(build.result).toEqual(original);
  await previewPlaceBuild("world", "place", "job1");
  expect(vi.mocked(previewPlaceScene).mock.lastCall![2].definition).toEqual(bound);
  await previewPlaceBuild("world", "place", "job1", true);
  expect(vi.mocked(previewPlaceScene).mock.lastCall![2].definition).toEqual(original);
  store("material_assets").clear(); await expect(materialBuildDefinition(db, build)).rejects.toMatchObject({ status: 409 });
});
it("replaces one failed material with new consent, never repeats siblings or ambiguous work", async () => {
  await materialBuild(); await queueBuildMaterials("world", "place", "job1", materialRequest);
  const items = structuredClone(materialStage().items), first = store("material_jobs").get(`world:${items[0].job_id}`)!;
  const request = { ...materialRequest, request_id: "replacement1", plan_id: items[0].plan_id };
  first.status = "submission_unknown";
  await expect(replaceBuildMaterial("world", "place", "job1", request)).rejects.toMatchObject({ status: 409 });
  await cancelBuildMaterials("world", "place", "job1", first.id);
  const replaced = await replaceBuildMaterial("world", "place", "job1", request);
  expect(await replaceBuildMaterial("world", "place", "job1", request)).toEqual(replaced);
  expect(store("material_jobs").size).toBe(3); expect(materialStage().items[1]).toEqual(items[1]);
  expect(materialStage().items[0].job_id).not.toBe(first.id); expect(materialStage().replacements).toHaveLength(1);
  expect(materialStage().reservation).toBeCloseTo(0.3);
});
it("cancels unsubmitted stage work once and retains reservations for already submitted siblings", async () => {
  await materialBuild(); await queueBuildMaterials("world", "place", "job1", materialRequest);
  [...store("material_jobs").values()][0]!.status = "queued";
  await cancelBuildMaterials("world", "place", "job1"); await cancelBuildMaterials("world", "place", "job1");
  expect(materialStage().cancelled).toBe(true);
  expect([...store("material_jobs").values()].every(j => j.status === "cancelled")).toBe(true);
  expect(store("spend_ledger").get(`sess:world:${new Date().toISOString().slice(0, 10)}`)!.total).toBeCloseTo(0.3);
});
it("refreshes storage only within a saved dependency and rejects modified parent results", async () => {
  const build = await materialBuild(); await queueBuildMaterials("world", "place", "job1", materialRequest);
  const child = [...store("material_jobs").values()][0]!; child.request_id = "known"; child.status = "storage_failed";
  await refreshBuildMaterial("world", "place", "job1", child.id);
  expect(child.status).toBe("queued"); expect(child.refresh_result).toBe(true);
  await expect(refreshBuildMaterial("world", "place", "job1", "other-job")).rejects.toMatchObject({ status: 404 });
  build.result!.label = "tampered";
  await expect(materialBuildDefinition(db, build)).rejects.toMatchObject({ status: 409 });
  expect(provider.mock.calls.filter(([url]) => url.endsWith("/submit"))).toHaveLength(0);
});
it("requires ownership for every action before reading provider or world data", async () => {
  memory.owner = false;
  for (const action of [() => placeBuildLibrary("world", "place"), () => queuePlaceBuild("world", "place", input), () => runPlaceBuild("world", "place", "job1"), () => cancelPlaceBuild("world", "place", "job1"), () => previewPlaceBuild("world", "place", "job1")]) await expect(action()).rejects.toMatchObject({ status: 403 });
  expect(provider).not.toHaveBeenCalled();
});
it("reserves a durable job once and never submits on queue, reload or status reads", async () => {
  await queuePlaceBuild("world", "place", input); await queuePlaceBuild("world", "place", input); await placeBuildLibrary("world", "place");
  expect(planCalls()).toHaveLength(0); expect(store("place_build_jobs").size).toBe(1);
  expect([...store("spend_ledger").values()].every(d => d.total === 0.2)).toBe(true);
});
it("deduplicates concurrent queue and execution requests", async () => {
  await Promise.all([queuePlaceBuild("world", "place", input), queuePlaceBuild("world", "place", input)]);
  await Promise.all([runPlaceBuild("world", "place", "job1"), runPlaceBuild("world", "place", "job1")]);
  expect(planCalls()).toHaveLength(0);
  await Promise.all([processNextPlaceBuild(db), processNextPlaceBuild(db)]);
  expect(planCalls()).toHaveLength(1); expect(store("place_build_jobs").size).toBe(1);
  expect([...store("spend_ledger").values()].every(d => d.total === 0.2)).toBe(true);
});
it("rejects reuse with a different prompt, revision or reservation, including a queue race", async () => {
  const results = await Promise.allSettled([queuePlaceBuild("world", "place", input), queuePlaceBuild("world", "place", { ...input, prompt: "Different" })]);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  for (const change of [{ base_revision: 2 }, { reservation: 0.3 }, { model: "changed" }]) await expect(queuePlaceBuild("world", "place", { ...input, ...change })).rejects.toMatchObject({ status: 409 });
});
it("requires consent, matching model cost and a current saved revision", async () => {
  await expect(queuePlaceBuild("world", "place", { ...input, confirmed: false })).rejects.toMatchObject({ status: 400 });
  await expect(queuePlaceBuild("world", "place", { ...input, reservation: 0.1 })).rejects.toMatchObject({ status: 409 });
  await expect(queuePlaceBuild("world", "place", { ...input, base_revision: 0 })).rejects.toMatchObject({ status: 409 });
  expect(store("spend_ledger").size).toBe(0); expect(planCalls()).toHaveLength(0);
});
it.each(["0", "-1", "NaN", "Infinity"])("rejects invalid build cap %s without reserving", async value => {
  vi.stubEnv("PLACE_BUILD_DAILY_CAP_USD", value);
  await expect(queuePlaceBuild("world", "place", input)).rejects.toMatchObject({ status: 503 }); expect(store("spend_ledger").size).toBe(0);
});
it("serializes cap reservations and rolls back an exceeded shared cap", async () => {
  vi.stubEnv("MAX_DAILY_SPEND", "0.3");
  const results = await Promise.allSettled([queuePlaceBuild("world", "place", input), queuePlaceBuild("world", "place", { ...input, id: "job2" })]);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(store("place_build_jobs").size).toBe(1); expect([...store("spend_ledger").values()].every(d => d.total === 0.2)).toBe(true);
});
it("persists accepted output and provenance; repeated runs and previews cost no calls", async () => {
  await queuePlaceBuild("world", "place", input); expect((await runAndWork()).job.status).toBe("ready");
  await runPlaceBuild("world", "place", "job1"); await previewPlaceBuild("world", "place", "job1");
  expect(planCalls()).toHaveLength(1);
  const doc = store("place_build_jobs").get("world:place:job1")!;
  expect(doc.receipt).toMatchObject({ job_id: "job1", request_id: "provider-job", base_revision: 1, object_ids: [doc.result.objects[0].id], reserved_usd: 0.2 });
  expect(vi.mocked(previewPlaceScene).mock.lastCall).toEqual(["world", "place", { base_revision: 1, definition: doc.result }, undefined, doc.receipt]);
  expect(store("place_scenes").get("world:place")!.definition.objects).toEqual([]);
});
it("does not run against a changed base and can release a never-submitted reservation", async () => {
  await queuePlaceBuild("world", "place", input); store("place_scenes").get("world:place")!.revision = 2;
  await expect(runPlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 409 });
  await cancelPlaceBuild("world", "place", "job1"); await cancelPlaceBuild("world", "place", "job1"); await runPlaceBuild("world", "place", "job1");
  expect(planCalls()).toHaveLength(0); expect([...store("spend_ledger").values()].every(d => d.total === 0)).toBe(true);
});
it("records ambiguous submission and never retries it", async () => {
  await queuePlaceBuild("world", "place", input); provider.mockRejectedValue(new Error("lost response"));
  expect((await runAndWork()).job.status).toBe("submission_unknown");
  await runPlaceBuild("world", "place", "job1"); await placeBuildLibrary("world", "place");
  expect(planCalls()).toHaveLength(1); expect([...store("spend_ledger").values()].every(d => d.total === 0.2)).toBe(true);
});
it("recovers an expired execution without treating a live deadline as terminal", async () => {
  await queuePlaceBuild("world", "place", input);
  const doc = store("place_build_jobs").get("world:place:job1")!; doc.status = "planning"; doc.deadline = new Date(Date.now() + 60_000);
  expect((await placeBuildLibrary("world", "place")).jobs[0]!.status).toBe("planning");
  doc.deadline = new Date(Date.now() - 1); expect((await placeBuildLibrary("world", "place")).jobs[0]!.status).toBe("submission_unknown");
  await runPlaceBuild("world", "place", "job1"); expect(planCalls()).toHaveLength(0);
});
it("keeps an in-flight cancellation terminal against a late result and retains spend", async () => {
  await queuePlaceBuild("world", "place", input);
  let finish!: (value: Response) => void; provider.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const run = runAndWork(); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await cancelPlaceBuild("world", "place", "job1");
  finish(Response.json({ status: "ready", model: "test-model", result: { objects: [newComponent("building", 20, 15)] } }));
  expect((await run).job.status).toBe("cancelled"); expect(store("place_build_jobs").get("world:place:job1")!.result).toBeUndefined();
  expect([...store("spend_ledger").values()].every(d => d.total === 0.2)).toBe(true);
});
it("rejects invalid geometry without committing or repairing it", async () => {
  await queuePlaceBuild("world", "place", input);
  provider.mockResolvedValue(Response.json({ status: "ready", model: "test-model", result: { objects: [newComponent("building", 0, 0)] } }));
  expect((await runAndWork()).job.status).toBe("invalid");
  await runPlaceBuild("world", "place", "job1"); expect(planCalls()).toHaveLength(1);
  await expect(previewPlaceBuild("world", "place", "job1")).rejects.toMatchObject({ status: 409 });
});

it("disables new reservations without a current worker heartbeat, retaining existing jobs", async () => {
  await queuePlaceBuild("world", "place", input);
  store("generation_workers").get("worker")!.last_seen = new Date(Date.now() - 31_000);
  expect((await placeBuildLibrary("world", "place")).capabilities).toMatchObject({ enabled: false });
  await expect(queuePlaceBuild("world", "place", { ...input, id: "job2" })).rejects.toMatchObject({ status: 503 });
  expect((await queuePlaceBuild("world", "place", input)).job.status).toBe("queued");
  expect(store("place_build_jobs").size).toBe(1);
});
it("does not claim reserved jobs until explicitly scheduled", async () => {
  await queuePlaceBuild("world", "place", input);
  expect(await processNextPlaceBuild(db)).toBe(false); expect(planCalls()).toHaveLength(0);
  expect((await runPlaceBuild("world", "place", "job1")).job.status).toBe("scheduled");
  expect(planCalls()).toHaveLength(0);
});
it("cancels scheduled jobs and releases the reservation exactly once", async () => {
  await queuePlaceBuild("world", "place", input); await runPlaceBuild("world", "place", "job1");
  await cancelPlaceBuild("world", "place", "job1"); await cancelPlaceBuild("world", "place", "job1");
  await processNextPlaceBuild(db);
  expect(planCalls()).toHaveLength(0); expect([...store("spend_ledger").values()].every(d => d.total === 0)).toBe(true);
});
it("rechecks scene hashes at worker claim and releases stale never-submitted jobs", async () => {
  await queuePlaceBuild("world", "place", input); await runPlaceBuild("world", "place", "job1");
  store("place_scenes").get("world:place")!.definition.label = "Changed between schedule and claim";
  await processNextPlaceBuild(db); await processNextPlaceBuild(db);
  expect(store("place_build_jobs").get("world:place:job1")!.status).toBe("cancelled");
  expect(planCalls()).toHaveLength(0); expect([...store("spend_ledger").values()].every(d => d.total === 0)).toBe(true);
});
it("recovers a persisted response after finalization failure without calling the model again", async () => {
  await queuePlaceBuild("world", "place", input); memory.failFinalization = true;
  await runAndWork();
  const saved = store("place_build_jobs").get("world:place:job1")!;
  expect(saved.status).toBe("validating"); expect(saved.provider_response.request_id).toBe("provider-job");
  expect(saved.result).toBeUndefined();
  memory.failFinalization = false; await processNextPlaceBuild(db);
  expect(saved.status).toBe("ready"); expect(saved.receipt.created_at).toBe(saved.received_at);
  expect(planCalls()).toHaveLength(1);
});
it("never reclaims an expired paid attempt and can accept its late known response", async () => {
  await queuePlaceBuild("world", "place", input); await runPlaceBuild("world", "place", "job1");
  const claimed = (await claimPlaceBuild())!;
  let finish!: (value: Response) => void;
  provider.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const executing = executePlaceBuild(db, claimed); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  store("place_build_jobs").get(claimed._id)!.deadline = new Date(Date.now() - 1);
  await processNextPlaceBuild(db);
  expect(store("place_build_jobs").get(claimed._id)!.status).toBe("submission_unknown");
  expect(await claimPlaceBuild()).toBeNull(); expect(planCalls()).toHaveLength(1);
  finish(Response.json({ status: "ready", model: "test-model", result: { objects: [newComponent("building", 20, 15)] } }));
  await executing;
  expect(store("place_build_jobs").get(claimed._id)!.status).toBe("ready");
});
it("fences stale executors and cancellation wins against validation recovery", async () => {
  await queuePlaceBuild("world", "place", input); await runPlaceBuild("world", "place", "job1");
  const claimed = (await claimPlaceBuild())!;
  await executePlaceBuild(db, { ...claimed, execution_token: "wrong-worker" });
  expect(store("place_build_jobs").get(claimed._id)!.status).toBe("planning");
  expect(planCalls()).toHaveLength(0);
  memory.failFinalization = true; await executePlaceBuild(db, claimed);
  const pending = structuredClone(store("place_build_jobs").get(claimed._id)) as BuildDoc;
  await cancelPlaceBuild("world", "place", "job1"); memory.failFinalization = false;
  await finalizePlaceBuild(db, pending);
  expect(store("place_build_jobs").get(claimed._id)!.status).toBe("cancelled");
  expect([...store("spend_ledger").values()].every(d => d.total === 0.2)).toBe(true);
});
it("fences duplicate executions even when both callers hold the same claim", async () => {
  await queuePlaceBuild("world", "place", input); await runPlaceBuild("world", "place", "job1");
  const claimed = (await claimPlaceBuild())!;
  await Promise.all([executePlaceBuild(db, claimed), executePlaceBuild(db, claimed)]);
  expect(planCalls()).toHaveLength(1);
});
it("does not submit a claimed task after its deadline or after cancellation", async () => {
  await queuePlaceBuild("world", "place", input); await runPlaceBuild("world", "place", "job1");
  const claimed = (await claimPlaceBuild())!;
  store("place_build_jobs").get(claimed._id)!.deadline = new Date(Date.now() - 1);
  await executePlaceBuild(db, claimed); expect(planCalls()).toHaveLength(0);
  await cancelPlaceBuild("world", "place", "job1");
  await executePlaceBuild(db, claimed); expect(planCalls()).toHaveLength(0);
});
it("quarantines incomplete saved responses instead of starving all later jobs", async () => {
  await queuePlaceBuild("world", "place", input);
  store("place_build_jobs").get("world:place:job1")!.status = "validating";
  await processNextPlaceBuild(db);
  expect(store("place_build_jobs").get("world:place:job1")!.status).toBe("submission_unknown");
  expect(await processNextPlaceBuild(db)).toBe(false); expect(planCalls()).toHaveLength(0);
});
