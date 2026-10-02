import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, Document>>(), owner: true, tail: Promise.resolve(), failPublication: false, failQueueAfterId: false }));
const store = (name: string) => { if (!memory.rows.has(name)) memory.rows.set(name, new Map()); return memory.rows.get(name)!; };
function matches(row: Document, q: Document): boolean {
  return Object.entries(q).every(([k, v]) => {
    if (k === "$or") return v.some((part: Document) => matches(row, part));
    if (k === "$and") return v.every((part: Document) => matches(row, part));
    const value = k.split(".").reduce((part, key) => part?.[key], row);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("$in" in v) return v.$in.includes(value);
      if ("$ne" in v) return value !== v.$ne;
      if ("$exists" in v) return (k in row) === v.$exists;
      if ("$lt" in v) return row[k] < v.$lt;
      if ("$lte" in v) return row[k] <= v.$lte;
      if ("$gt" in v) return row[k] > v.$gt;
    }
    return value === v;
  });
}
function collection(name: string) {
  const find = (q: Document) => [...store(name).values()].filter(row => matches(row, q));
  const update = (row: Document, change: Document) => {
    if (memory.failPublication && name === "mesh_assets") throw new Error("Asset publication unavailable");
    if (memory.failQueueAfterId && change.$set?.status === "queued") throw new Error("Write failed after request ID");
    Object.assign(row, change.$set);
    for (const [k, v] of Object.entries(change.$inc ?? {})) row[k] = (row[k] ?? 0) + Number(v);
    for (const k of Object.keys(change.$unset ?? {})) delete row[k];
  };
  return {
    findOne: async (q: Document) => structuredClone(find(q)[0] ?? null),
    countDocuments: async (q: Document) => find(q).length,
    find: (q: Document) => { const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => structuredClone(find(q)) }; return cursor; },
    findOneAndUpdate: async (q: Document, change: Document) => { const row = find(q)[0]; if (!row) return null; update(row, change); return structuredClone(row); },
    insertOne: async (row: Document) => { if (store(name).has(row._id)) throw new Error("duplicate"); store(name).set(row._id, structuredClone(row)); },
    updateOne: async (q: Document, change: Document, options: Document = {}) => {
      let row = find(q)[0]; if (!row && options.upsert) { const fresh: Document = { _id: q._id, ...change.$setOnInsert }; store(name).set(fresh._id, fresh); row = fresh; }
      if (row) update(row, change);
      return { matchedCount: row ? 1 : 0 };
    },
    updateMany: async (q: Document, change: Document) => { for (const row of find(q)) update(row, change); },
  };
}
const db = { collection } as unknown as Db;
vi.mock("./db", () => ({ withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>) => {
  const previous = memory.tail; let release!: () => void; memory.tail = new Promise<void>(resolve => { release = resolve; }); await previous;
  const before = structuredClone(memory.rows);
  try { return await run(db, {} as ClientSession); } catch (e) { memory.rows = before; throw e; } finally { release(); }
} }));
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => { if (!memory.owner) throw Object.assign(new Error("Not owner"), { status: 403 }); return db; } }));
vi.mock("./r2", () => ({ uploadJpeg: vi.fn(), getStoredBytes: vi.fn() }));
import { meshLibrary, submitMesh, refreshMesh, cancelMesh, meshBytes, meshDimensions } from "./mesh-server";
import { processNextMeshJob } from "./mesh-execution";
import { processNextAssetJob } from "./mesh-execution";
import { MATERIAL_MODEL } from "./asset-pipeline";
import { fixtureMaterial } from "../e2e/fixtures/material-jpeg";
import { MESH_MODEL, MESH_IMAGE_MODEL } from "./mesh-asset";
import { saveMeshSource, meshSources, meshSourceBytes, readMeshSource } from "./mesh-source";
import { uploadJpeg, getStoredBytes } from "./r2";
import { buildInputHash } from "./place-build-execution";
import { emptyPlaceScene, newComponent, sceneGeos } from "./place-scene";
import { adjacentPlacement } from "./place-connections";
const provider = vi.fn(), parameters = { enable_pbr: true, face_count: 40000, generate_type: "LowPoly", polygon_type: "triangle" };
const config = { enabled: true, model: MESH_MODEL, reservation: 2, parameters };
const input = { id: "run1", prompt: "A stone bakery", confirmed: true, reservation: 2, model: MESH_MODEL, parameters };
const submitted = () => provider.mock.calls.filter(([url]) => url.endsWith("/submit"));
const job = (id = "run1") => store("mesh_jobs").get(`world:${id}`)!;
function glb(count = 3) {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ count }] }));
  const length = Math.ceil(json.length / 4) * 4, bytes = Buffer.alloc(20 + length, 32);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20); return bytes;
}
async function queued() { await submitMesh("world", input); await processNextMeshJob(db); expect(job().status).toBe("queued"); }
function ready(bytes = glb()) { provider.mockImplementation(async (url: string) => url.includes("/requests/") ? Response.json({ status: "ready", model_glb: { url: "https://fal.media/model.glb" }, seed: 7 }) : new Response(bytes)); }
beforeEach(() => {
  memory.rows.clear(); memory.owner = true; memory.tail = Promise.resolve(); memory.failPublication = false; memory.failQueueAfterId = false;
  provider.mockReset(); vi.stubGlobal("fetch", provider); vi.mocked(uploadJpeg).mockReset(); vi.mocked(getStoredBytes).mockReset();
  vi.stubEnv("MODAL_API_URL", "https://backend.test"); vi.stubEnv("MESH_DAILY_CAP_USD", "4"); vi.stubEnv("MAX_SESSION_SPEND", "0"); vi.stubEnv("MAX_DAILY_SPEND", "0");
  store("generation_workers").set("worker", { _id: "worker", kind: "place-layout", mesh: true, last_seen: new Date() });
  provider.mockImplementation(async (url: string) => Response.json(url.endsWith("capabilities") ? config : url.endsWith("/submit") ? { request_id: "request1", model: MESH_MODEL } : { status: "running" }));
  vi.mocked(uploadJpeg).mockImplementation(async (key, _bytes, contentType) => ({ key, url: `https://storage.test/${key}`, contentType: contentType! }));
});
it.each(["revision", "geometry", "result", "plan", "connections"])("cancels a stale %s dependency before paid submission and refunds once", async change => {
  await submitMesh("world", input);
  const definition = { label: "source" }, result = { label: "accepted" }, mesh_plan = [{ id: "arch" }];
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1, definition });
  store("place_build_jobs").set("world:place:build", { _id: "world:place:build", session_id: "world", place_id: "place", status: "ready", result, mesh_plan });
  job().dependency = { kind: "mesh", place_id: "place", revision: 1, input_sha256: buildInputHash(definition), build_key: "world:place:build", result_sha256: buildInputHash(result), plan_sha256: buildInputHash(mesh_plan) };
  if (change === "revision") store("place_scenes").get("world:place")!.revision = 2;
  if (change === "geometry") definition.label = "changed";
  if (change === "result") result.label = "changed";
  if (change === "plan") mesh_plan[0]!.id = "changed";
  if (change === "connections") store("place_connections").set("road", { _id: "road", session_id: "world", id: "road", version: 1, kind: "boundary", width: 4, created_at: "2026-09-13", a: { place_id: "place", side: "east", offset: 20 }, b: { place_id: "neighbor", side: "west", offset: 20 } });
  await processNextMeshJob(db); await processNextMeshJob(db);
  expect(job().status).toBe("cancelled"); expect(submitted()).toHaveLength(0);
  expect([...store("spend_ledger").values()].every(row => row.total === 0)).toBe(true);
});
it("submits a valid mesh dependency once and preserves it in immutable asset provenance", async () => {
  await submitMesh("world", input);
  const definition = { label: "source" }, result = { label: "accepted" }, mesh_plan = [{ id: "arch" }];
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1, definition });
  store("place_build_jobs").set("world:place:build", { _id: "world:place:build", session_id: "world", status: "ready", result, mesh_plan });
  const dependency = { kind: "mesh", place_id: "place", revision: 1, input_sha256: buildInputHash(definition), build_key: "world:place:build", result_sha256: buildInputHash(result), plan_sha256: buildInputHash(mesh_plan) };
  job().dependency = dependency;
  await Promise.all([processNextMeshJob(db), processNextMeshJob(db)]);
  expect(submitted()).toHaveLength(1); expect(job().request_id).toBe("request1");
  job().next_check = new Date(0); ready(); await processNextMeshJob(db);
  expect(job().status).toBe("ready"); expect(store("mesh_assets").get("world:mesh_run1")!.dependency).toEqual(dependency);
});
it("requires ownership before job, provider or asset access", async () => {
  memory.owner = false;
  for (const action of [() => meshLibrary("world"), () => submitMesh("world", input), () => refreshMesh("world", "run1"), () => cancelMesh("world", "run1"), () => meshBytes("world", "mesh1"), () => meshDimensions("world", "mesh1")]) await expect(action()).rejects.toMatchObject({ status: 403 });
  expect(provider).not.toHaveBeenCalled();
});

const materialInput = { ...input, model: MATERIAL_MODEL, reservation: 0.1, parameters: { prompt_version: "fixture" } };
function enableMaterials() {
  store("generation_workers").get("worker")!.material = true;
  provider.mockImplementation(async (url: string) => Response.json(url.endsWith("capabilities") ? url.includes("/material/") ? { ...config, model: MATERIAL_MODEL, reservation: 0.1, parameters: materialInput.parameters } : config : { request_id: "material-request", model: MATERIAL_MODEL }));
}
it.each([undefined, "material", "mesh"])("validates the material dependency kind %s without breaking legacy jobs", async kind => {
  enableMaterials(); await submitMesh("world", materialInput, "material");
  const definition = { label: "source" }, result = { label: "accepted" }, material_plan = [{ id: "stone" }];
  store("place_scenes").set("world:place", { _id: "world:place", revision: 1, definition });
  store("place_build_jobs").set("world:place:build", { _id: "world:place:build", session_id: "world", status: "ready", result, material_plan });
  const saved = store("material_jobs").get("world:run1")!;
  saved.dependency = { ...(kind ? { kind } : {}), place_id: "place", revision: 1, input_sha256: buildInputHash(definition), build_key: "world:place:build", result_sha256: buildInputHash(result), plan_sha256: buildInputHash(material_plan) };
  await processNextAssetJob(db, "material");
  expect(saved.status).toBe(kind === "mesh" ? "cancelled" : "queued");
  expect(submitted()).toHaveLength(kind === "mesh" ? 0 : 1);
  if (kind === "mesh") expect([...store("spend_ledger").values()].every(row => row.total === 0)).toBe(true);
});
it("shares durable processing without mixing mesh and material jobs or assets", async () => {
  enableMaterials(); await submitMesh("world", materialInput, "material");
  expect(await processNextMeshJob(db)).toBe(false); expect(submitted()).toHaveLength(0);
  await Promise.all([processNextAssetJob(db, "material"), processNextAssetJob(db, "material")]);
  expect(submitted()).toHaveLength(1); expect(submitted()[0]![0]).toBe("https://backend.test/material/submit");
  provider.mockImplementation(async (url: string) => url.includes("/requests/") ? Response.json({ status: "ready", image: { url: "https://fal.media/material.jpg" } }) : new Response(new Uint8Array(fixtureMaterial())));
  await processNextAssetJob(db, "material");
  const saved = store("material_assets").get("world:material_run1")!;
  expect(saved.image).toMatchObject({ width: 256, height: 256, channel: "base_color", tiling: "unverified" });
  expect(saved.key).toMatch(/\.jpg$/); expect(store("mesh_assets").size).toBe(0);
  expect(vi.mocked(uploadJpeg).mock.calls[0]![2]).toBe("image/jpeg");
  vi.mocked(getStoredBytes).mockResolvedValue({ bytes: fixtureMaterial(), contentType: "image/jpeg" });
  expect(await meshBytes("world", "material_run1", "material")).toEqual(fixtureMaterial());
  expect((await meshLibrary("world", "material")).assets[0]).toMatchObject({ id: "material_run1", sha256: saved.sha256 });
});
it("material reservations compete with mesh work in the shared budget", async () => {
  enableMaterials(); vi.stubEnv("MAX_DAILY_SPEND", "2.05");
  const results = await Promise.allSettled([submitMesh("world", input), submitMesh("world", materialInput, "material")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(store("mesh_jobs").size + store("material_jobs").size).toBe(1); expect(submitted()).toHaveLength(0);
});
it("material cancellation refunds only unclaimed work, without another submission", async () => {
  enableMaterials(); await submitMesh("world", materialInput, "material");
  await cancelMesh("world", "run1", "material"); await cancelMesh("world", "run1", "material");
  expect(await processNextAssetJob(db, "material")).toBe(false);
  expect([...store("spend_ledger").values()].every(row => row.total === 0)).toBe(true);
});
it("material submission ambiguity is retained rather than retried", async () => {
  enableMaterials(); await submitMesh("world", materialInput, "material"); provider.mockRejectedValue(new Error("Lost response"));
  await processNextAssetJob(db, "material");
  expect(store("material_jobs").get("world:run1")?.status).toBe("submission_unknown");
  await refreshMesh("world", "run1", "material"); await processNextAssetJob(db, "material"); expect(submitted()).toHaveLength(1);
});
it("material storage retry retains the request and immutable downloaded bytes", async () => {
  enableMaterials(); await submitMesh("world", materialInput, "material"); await processNextAssetJob(db, "material");
  provider.mockImplementation(async (url: string) => url.includes("/requests/") ? Response.json({ status: "ready", image: { url: "https://fal.media/material.jpg" } }) : new Response(new Uint8Array(fixtureMaterial())));
  vi.mocked(uploadJpeg).mockRejectedValueOnce(new Error("Storage unavailable"));
  await processNextAssetJob(db, "material"); expect(store("material_jobs").get("world:run1")?.status).toBe("storage_failed");
  const calls = provider.mock.calls.length; await meshLibrary("world", "material"); await processNextAssetJob(db, "material");
  expect(provider.mock.calls.length).toBe(calls + 1);
  await refreshMesh("world", "run1", "material"); await processNextAssetJob(db, "material");
  expect(store("material_jobs").get("world:run1")?.status).toBe("ready"); expect(submitted()).toHaveLength(1);
});
it("requires consent and matching reservation/model/parameters", async () => {
  await expect(submitMesh("world", { ...input, confirmed: false })).rejects.toMatchObject({ status: 400 });
  for (const changed of [{ reservation: 1 }, { model: "other" }, { parameters: { face_count: 90000 } }]) await expect(submitMesh("world", { ...input, ...changed })).rejects.toMatchObject({ status: 409 });
  expect(store("mesh_jobs").size).toBe(0);
});
it("only reserves on generate; reads and refresh cannot submit models", async () => {
  expect((await submitMesh("world", input)).job.status).toBe("scheduled");
  await meshLibrary("world"); await refreshMesh("world", "run1");
  expect(submitted()).toHaveLength(0); expect([...store("spend_ledger").values()].every(row => row.total === 2)).toBe(true);
});
it("deduplicates concurrent reservations and worker claims", async () => {
  await Promise.all([submitMesh("world", input), submitMesh("world", input)]);
  await Promise.all([processNextMeshJob(db), processNextMeshJob(db)]);
  expect(submitted()).toHaveLength(1); expect([...store("spend_ledger").values()].every(row => row.total === 2)).toBe(true);
  expect(JSON.parse(submitted()[0]![1].body)).toEqual({ prompt: input.prompt, model: MESH_MODEL, reservation: 2, parameters });
});
it("rejects racing request-ID reuse with a different prompt", async () => {
  const results = await Promise.allSettled([submitMesh("world", input), submitMesh("world", { ...input, prompt: "Different" })]);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  await expect(submitMesh("world", { ...input, reservation: 1 })).rejects.toMatchObject({ status: 409 });
});
it("caps concurrent reservations without partial ledger writes", async () => {
  vi.stubEnv("MAX_DAILY_SPEND", "3");
  const results = await Promise.allSettled([submitMesh("world", input), submitMesh("world", { ...input, id: "run2" })]);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(store("mesh_jobs").size).toBe(1); expect([...store("spend_ledger").values()].every(row => row.total === 2)).toBe(true);
});
it.each(["MESH_DAILY_CAP_USD", "MAX_DAILY_SPEND", "MAX_SESSION_SPEND"])("fails closed on invalid %s", async name => {
  for (const value of ["-1", "NaN", "Infinity"]) { vi.stubEnv(name, value); await expect(submitMesh("world", input)).rejects.toMatchObject({ status: 503 }); }
  expect(store("mesh_jobs").size).toBe(0);
});
it("requires a live storage-capable worker only for new jobs", async () => {
  await submitMesh("world", input); store("generation_workers").get("worker")!.mesh = false;
  expect((await meshLibrary("world")).capabilities.enabled).toBe(false);
  expect((await submitMesh("world", input)).job.status).toBe("scheduled");
  await expect(submitMesh("world", { ...input, id: "run2" })).rejects.toMatchObject({ status: 503 });
});
it("keeps ambiguous submissions reserved and never resubmits", async () => {
  await submitMesh("world", input); provider.mockRejectedValue(new Error("Lost acknowledgement"));
  await processNextMeshJob(db); expect(job().status).toBe("submission_unknown");
  await submitMesh("world", input); await refreshMesh("world", "run1"); await processNextMeshJob(db);
  expect(submitted()).toHaveLength(1); expect([...store("spend_ledger").values()].every(row => row.total === 2)).toBe(true);
});
it("recovers a known ID if the following status write fails", async () => {
  await submitMesh("world", input); memory.failQueueAfterId = true; await processNextMeshJob(db);
  expect(job()).toMatchObject({ status: "submission_unknown", request_id: "request1" });
  memory.failQueueAfterId = false; await processNextMeshJob(db);
  expect(job().status).toBe("running"); expect(submitted()).toHaveLength(1);
});
it("expires legacy and worker submissions without treating live deadlines as failures", async () => {
  await submitMesh("world", input);
  Object.assign(job(), { status: "submitting", submission_deadline: new Date(Date.now() + 60_000) });
  await meshLibrary("world"); expect(job().status).toBe("submitting");
  job().submission_deadline = new Date(Date.now() - 1); await processNextMeshJob(db); expect(job().status).toBe("submission_unknown");
  Object.assign(job(), { status: "submitting", created_at: new Date(Date.now() - 180_000) }); delete job().submission_deadline;
  await processNextMeshJob(db); expect(job().status).toBe("submission_unknown"); expect(submitted()).toHaveLength(0);
});
it("backs off failed status reads and polls only the saved provider ID", async () => {
  await queued(); provider.mockRejectedValue(new Error("Read timeout")); await processNextMeshJob(db);
  expect(job().status).toBe("queued"); expect(job().next_check.getTime()).toBeGreaterThan(Date.now());
  const count = provider.mock.calls.length; await processNextMeshJob(db); expect(provider.mock.calls).toHaveLength(count);
  await refreshMesh("world", "run1"); provider.mockResolvedValue(Response.json({ status: "running" })); await processNextMeshJob(db);
  expect(job().status).toBe("running"); expect(provider.mock.lastCall?.[0]).toBe("https://backend.test/mesh/requests/request1"); expect(submitted()).toHaveLength(1);
});
it("terminal provider failure stays terminal with reserved spend", async () => {
  await queued(); provider.mockResolvedValue(Response.json({ status: "failed" })); await processNextMeshJob(db);
  expect(job().status).toBe("failed"); const count = provider.mock.calls.length;
  await refreshMesh("world", "run1"); await processNextMeshJob(db); expect(provider.mock.calls).toHaveLength(count);
  expect([...store("spend_ledger").values()].every(row => row.total === 2)).toBe(true);
});
it("rejects cross-world jobs and assets", async () => {
  await submitMesh("world", input);
  for (const action of [() => refreshMesh("other", "run1"), () => cancelMesh("other", "run1"), () => meshBytes("other", "mesh1")]) await expect(action()).rejects.toMatchObject({ status: 404 });
});
it("stores and publishes a completed asset atomically with provenance", async () => {
  await queued(); ready(); await processNextMeshJob(db);
  expect(job()).toMatchObject({ status: "ready", asset_id: "mesh_run1" });
  const asset = store("mesh_assets").get("world:mesh_run1")!; expect(asset.parameters).toEqual(parameters); expect(asset.sha256).toBe(job().download.sha256);
  const calls = provider.mock.calls.length; await refreshMesh("world", "run1"); await processNextMeshJob(db); expect(provider.mock.calls).toHaveLength(calls);
  vi.mocked(getStoredBytes).mockResolvedValue({ bytes: glb(), contentType: "model/gltf-binary" }); expect(await meshBytes("world", "mesh_run1")).toEqual(glb());
  vi.mocked(getStoredBytes).mockResolvedValue({ bytes: Buffer.from("corrupt"), contentType: "model/gltf-binary" }); await expect(meshBytes("world", "mesh_run1")).rejects.toMatchObject({ status: 503 });
});
it("can load the prefixed asset for the longest accepted request ID", async () => {
  const id = "a".repeat(128);
  await submitMesh("world", { ...input, id }); await processNextMeshJob(db); ready(); await processNextMeshJob(db);
  expect(job(id).asset_id).toBe(`mesh_${id}`);
  vi.mocked(getStoredBytes).mockResolvedValue({ bytes: glb(), contentType: "model/gltf-binary" });
  expect(await meshBytes("world", `mesh_${id}`)).toEqual(glb());
  await expect(meshBytes("world", "../mesh")).rejects.toMatchObject({ status: 400 });
});
it("requires explicit storage retry after download failure, preserving the provider result", async () => {
  await queued(); ready(); vi.mocked(uploadJpeg).mockRejectedValueOnce(new Error("Disk unavailable")); await processNextMeshJob(db);
  expect(job()).toMatchObject({ status: "storage_failed", provider_result: { seed: 7 } }); expect(store("mesh_assets").size).toBe(0);
  const calls = provider.mock.calls.length; await processNextMeshJob(db); expect(provider.mock.calls).toHaveLength(calls);
  await refreshMesh("world", "run1"); await processNextMeshJob(db); expect(job().status).toBe("ready");
  expect(submitted()).toHaveLength(1); expect(provider.mock.calls.filter(([url]) => url.includes("/requests/"))).toHaveLength(2);
});
it("retries a failed publication without creating a conflicting asset or generating again", async () => {
  await queued(); ready(); memory.failPublication = true; await processNextMeshJob(db);
  expect(job().status).toBe("storage_failed"); expect(store("mesh_assets").size).toBe(0);
  memory.failPublication = false; await refreshMesh("world", "run1"); await processNextMeshJob(db);
  expect(job().status).toBe("ready"); expect(store("mesh_assets").size).toBe(1); expect(submitted()).toHaveLength(1);
});
it("rejects changed provider bytes during storage recovery", async () => {
  await queued(); ready(); vi.mocked(uploadJpeg).mockRejectedValueOnce(new Error("Disk unavailable")); await processNextMeshJob(db);
  ready(glb(6)); await refreshMesh("world", "run1"); await processNextMeshJob(db);
  expect(job().status).toBe("storage_failed"); expect(job().error).toContain("changed the saved asset bytes"); expect(store("mesh_assets").size).toBe(0);
});
it("publishes an already uploaded immutable blob even when the provider is unavailable", async () => {
  await queued(); ready(); memory.failPublication = true; await processNextMeshJob(db);
  expect(job().status).toBe("storage_failed"); const calls = provider.mock.calls.length;
  vi.mocked(getStoredBytes).mockResolvedValue({ bytes: glb(), contentType: "model/gltf-binary" });
  provider.mockRejectedValue(new Error("Provider unavailable")); memory.failPublication = false;
  await refreshMesh("world", "run1"); await processNextMeshJob(db);
  expect(job().status).toBe("ready"); expect(provider.mock.calls).toHaveLength(calls); expect(uploadJpeg).toHaveBeenCalledTimes(1);
});
it("rejects untrusted download hosts without fetching them", async () => {
  await queued(); provider.mockResolvedValue(Response.json({ status: "ready", model_glb: { url: "http://127.0.0.1/private" } })); await processNextMeshJob(db);
  expect(job().status).toBe("storage_failed"); expect(provider.mock.calls.some(([url]) => url.includes("/private"))).toBe(false);
});
it("refunds scheduled cancellations exactly once and never refunds provider work", async () => {
  await submitMesh("world", input); await cancelMesh("world", "run1"); await cancelMesh("world", "run1"); await processNextMeshJob(db);
  expect(submitted()).toHaveLength(0); expect([...store("spend_ledger").values()].every(row => row.total === 0)).toBe(true);
});
it("keeps cancellation terminal against late provider acknowledgement", async () => {
  await submitMesh("world", input); let finish!: (value: Response) => void;
  provider.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const working = processNextMeshJob(db); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await cancelMesh("world", "run1"); finish(Response.json({ request_id: "request1", model: MESH_MODEL })); await working;
  expect(job()).toMatchObject({ status: "cancelled", request_id: "request1" }); expect([...store("spend_ledger").values()].every(row => row.total === 2)).toBe(true);
});
it("keeps cancellation terminal against an in-flight upload", async () => {
  await queued(); ready(); let finish!: () => void;
  vi.mocked(uploadJpeg).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ key: "saved", url: "", contentType: "model/gltf-binary" }); }));
  const working = processNextMeshJob(db); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await cancelMesh("world", "run1"); finish(); await working;
  expect(job().status).toBe("cancelled"); expect(store("mesh_assets").size).toBe(0);
});
it("reclaims only expired read leases and fences a late old worker", async () => {
  await queued(); let finish!: (value: Response) => void;
  provider.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const first = processNextMeshJob(db); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(await processNextMeshJob(db)).toBe(false);
  job().work_until = new Date(Date.now() - 1); ready(); await processNextMeshJob(db); expect(job().status).toBe("ready");
  finish(Response.json({ status: "failed" })); await first; expect(job().status).toBe("ready"); expect(submitted()).toHaveLength(1);
});
import sharp from "sharp";

async function imageFixture() {
  const blobs = new Map<string, Buffer>();
  vi.mocked(uploadJpeg).mockImplementation(async (key, bytes, contentType) => { blobs.set(key, Buffer.from(bytes)); return { key, url: "", contentType: contentType! }; });
  vi.mocked(getStoredBytes).mockImplementation(async key => blobs.has(key) ? { bytes: blobs.get(key)!, contentType: "image/png" } : null);
  store("generation_workers").get("worker")!.mesh_image = true;
  provider.mockImplementation(async (url: string) => Response.json(url.endsWith("image-capabilities") ? { ...config, model: MESH_IMAGE_MODEL } : url.endsWith("capabilities") ? config : url.endsWith("/submit") ? { request_id: "image1", model: MESH_IMAGE_MODEL } : { status: "running" }));
  const original = await sharp(fixtureMaterial()).resize(96, 64).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const request = { label: "Rotated concept", data_url: `data:image/jpeg;base64,${original.toString("base64")}` };
  const { source } = await saveMeshSource("world", request);
  return { blobs, original, request, source, input: { ...input, model: MESH_IMAGE_MODEL, source_id: source.id } };
}
it("freezes original and orientation-correct input without model calls or private keys in the library", async () => {
  const f = await imageFixture(), source = await readMeshSource(db, "world", f.source.id);
  expect(f.source).toMatchObject({ width: 64, height: 96, origin: { kind: "imported_reference" } });
  expect(await meshSourceBytes(source, true)).toEqual(f.original);
  expect((await sharp(await meshSourceBytes(source)).metadata()).orientation).toBeUndefined();
  expect(await saveMeshSource("world", f.request)).toEqual({ source: f.source });
  expect(uploadJpeg).toHaveBeenCalledTimes(2); expect(submitted()).toHaveLength(0);
  const library = await meshSources("world"); expect(library.sources).toEqual([f.source]); expect(JSON.stringify(library)).not.toContain(source.key);
});
it("accepted world images are ownership-scoped, frozen and explicitly referenced", async () => {
  const f = await imageFixture();
  f.blobs.set("node/image", f.original);
  store("nodes").set("accepted", { _id: "accepted", session_id: "world", image_key: "node/image", page_title: "Accepted sketch", image_model: "sketch-provider" });
  const { source } = await saveMeshSource("world", { node_id: "accepted" });
  expect(source.origin).toEqual({ kind: "saved_world_image", node_id: "accepted", image_model: "sketch-provider" });
  store("nodes").delete("accepted");
  const record = await readMeshSource(db, "world", source.id);
  expect(await meshSourceBytes(record, true)).toEqual(f.original);
  await expect(saveMeshSource("other", { node_id: "accepted" })).rejects.toMatchObject({ status: 404 });
  await expect(readMeshSource(db, "other", source.id)).rejects.toMatchObject({ status: 404 });
});
it("repairs missing concept blobs by re-importing identical bytes without new identities or generation", async () => {
  const f = await imageFixture(), source = await readMeshSource(db, "world", f.source.id);
  f.blobs.delete(source.key); f.blobs.delete(source.original.key);
  expect(await saveMeshSource("world", f.request)).toEqual({ source: f.source });
  expect(await meshSourceBytes(source, true)).toEqual(f.original);
  expect(store("mesh_sources").size).toBe(1); expect(submitted()).toHaveLength(0);
});
it.each(["data:image/svg+xml;base64,AAAA", "data:image/png;base64,AAAA", "https://internal/image"])("rejects unsupported concept data %s before storage", async data_url => {
  await expect(saveMeshSource("world", { data_url })).rejects.toMatchObject({ status: 400 }); expect(uploadJpeg).not.toHaveBeenCalled();
});
it("requires explicit image source, consent and a completed worker rollout before reservation", async () => {
  const f = await imageFixture();
  await expect(submitMesh("world", { ...f.input, source_id: undefined })).rejects.toMatchObject({ status: 400 });
  await expect(submitMesh("world", { ...f.input, model: MESH_MODEL })).rejects.toMatchObject({ status: 400 });
  await expect(submitMesh("world", { ...f.input, confirmed: false })).rejects.toMatchObject({ status: 400 });
  store("generation_workers").set("old", { _id: "old", kind: "place-layout", mesh: true, last_seen: new Date() });
  await expect(submitMesh("world", f.input)).rejects.toMatchObject({ status: 503 });
  expect((await meshLibrary("world")).image_capabilities.enabled).toBe(false);
  expect(store("spend_ledger").size).toBe(0);
});
it("pins an image request, recovers by its saved model and retains immutable input on the asset", async () => {
  const f = await imageFixture(); await submitMesh("world", f.input); await submitMesh("world", f.input);
  await expect(submitMesh("world", { ...f.input, source_id: "b".repeat(64) })).rejects.toMatchObject({ status: 409 });
  await processNextMeshJob(db); expect(job()).toMatchObject({ status: "queued", request_id: "image1", source_id: f.source.id });
  const sent = JSON.parse(submitted()[0]![1].body); expect(sent.input_image_url).toBe(`data:image/png;base64,${(await meshSourceBytes(job().image_input)).toString("base64")}`);
  expect(sent).not.toHaveProperty("source_id");
  ready(); await processNextMeshJob(db);
  expect(provider.mock.calls.some(([url]) => url === `https://backend.test/mesh/requests/image1?model=${encodeURIComponent(MESH_IMAGE_MODEL)}`)).toBe(true);
  const asset = store("mesh_assets").get("world:mesh_run1")!;
  expect(asset.image_input).toEqual(job().image_input); expect(asset.model).toBe(MESH_IMAGE_MODEL);
  await refreshMesh("world", "run1"); await processNextMeshJob(db); expect(submitted()).toHaveLength(1);
});
it("waits for unavailable concept storage before the paid claim, then resumes once", async () => {
  const f = await imageFixture(); await submitMesh("world", f.input);
  const source = job().image_input, saved = f.blobs.get(source.key)!; f.blobs.delete(source.key);
  await processNextMeshJob(db); expect(job().status).toBe("scheduled"); expect(job().error).toContain("no generation");
  expect(job().submission_token).toBeUndefined(); expect(submitted()).toHaveLength(0);
  f.blobs.set(source.key, saved); await processNextMeshJob(db); expect(submitted()).toHaveLength(0);
  job().next_check = new Date(0); await processNextMeshJob(db); expect(submitted()).toHaveLength(1);
});
it("refunds corrupted frozen concepts once without submitting", async () => {
  const f = await imageFixture(); await submitMesh("world", f.input); f.blobs.set(job().image_input.key, Buffer.from("changed"));
  await processNextMeshJob(db); await processNextMeshJob(db);
  expect(job().status).toBe("cancelled"); expect(submitted()).toHaveLength(0);
  expect([...store("spend_ledger").values()].every(row => row.total === 0)).toBe(true);
});
it("keeps ambiguous image submission terminal and never automatically resubmits", async () => {
  const f = await imageFixture(); await submitMesh("world", f.input);
  provider.mockRejectedValue(new Error("Lost response")); await processNextMeshJob(db);
  expect(job().status).toBe("submission_unknown"); await processNextMeshJob(db); expect(submitted()).toHaveLength(1);
});
import { ILLUSTRATION_MODEL, ILLUSTRATION_EDIT_MODEL } from "./asset-pipeline";
import { submitIllustration, illustrationLibrary, illustrationAction } from "./illustration-server";
import { bindings, currentSources, type PlaceViewDoc } from "./place-view-store";
import { illustrationDependency } from "./illustration-input";
import { VIEW_PASSES } from "./place-view";
import { createHash } from "node:crypto";
import { registeredPixels } from "./illustration-region";
const illustrationInput = { ...input, model: ILLUSTRATION_MODEL, reservation: 0.1, parameters: { prompt_version: "fixture" } };
const illustrationJob = () => store("illustration_jobs").get("world:run1")!;
async function enableIllustrations() {
  vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES", "1"); vi.stubEnv("ILLUSTRATION_DAILY_CAP_USD", "4");
  store("generation_workers").get("worker")!.illustration = true;
  store("generation_workers").get("worker")!.illustration_region = true;
  const definition = { version: 2, label: "Courtyard", objects: [] };
  store("place_scenes").set("world:place", { _id: "world:place", session_id: "world", id: "scene", place_id: "place", revision: 1, definition });
  const sources = [{ scene_id: "scene", place_id: "place", revision: 1, definition, x: 0, z: 0 }];
  const png = await sharp(fixtureMaterial()).png().toBuffer();
  const sha256 = createHash("sha256").update(png).digest("hex");
  const view = { _id: "world:view", id: "view", session_id: "world", root_place_id: "place", request_sha256: "capture",
    width: 256, height: 256, mode: "orbit", ...await bindings(db, "world", sources as never),
    files: Object.fromEntries(VIEW_PASSES.map(pass => [pass, { key: pass, sha256, bytes: png.length }])) } as PlaceViewDoc;
  store("place_views").set(view._id, view);
  const blobs = new Map<string, Buffer>(VIEW_PASSES.map(pass => [pass, png]));
  vi.mocked(getStoredBytes).mockImplementation(async key => blobs.has(key) ? { bytes: blobs.get(key)!, contentType: "image/png" } : null);
  vi.mocked(uploadJpeg).mockImplementation(async (key, bytes, contentType) => { blobs.set(key, Buffer.from(bytes)); return { key, url: "", contentType: contentType! }; });
  provider.mockImplementation(async (url: string) => Response.json(url.endsWith("capabilities") ? { enabled: true, model: ILLUSTRATION_MODEL, reservation: 0.1, parameters: illustrationInput.parameters } : { request_id: "illustration-request", model: ILLUSTRATION_MODEL }));
  return { view, png, blobs };
}
function readyIllustration(bytes = fixtureMaterial()) {
  provider.mockImplementation(async (url: string) => url.includes("/requests/") ? Response.json({ status: "ready", image: { url: "https://fal.media/view.jpg" } }) : new Response(new Uint8Array(bytes)));
}
it("illustrations reserve once and submit saved color/depth bytes without client-supplied URLs", async () => {
  const { view, png } = await enableIllustrations();
  await Promise.all([submitIllustration("world", "view", illustrationInput), submitIllustration("world", "view", illustrationInput)]);
  expect(submitted()).toHaveLength(0);
  await Promise.all([processNextAssetJob(db, "illustration"), processNextAssetJob(db, "illustration")]);
  expect(submitted()).toHaveLength(1);
  const payload = JSON.parse(submitted()[0]![1].body);
  expect(payload.inputs).toEqual({ image_url: `data:image/png;base64,${png.toString("base64")}`, control_lora_image_url: `data:image/png;base64,${png.toString("base64")}`, image_size: { width: 256, height: 256 } });
  expect(illustrationJob().view_dependency).toEqual(illustrationDependency(view));
  expect([...store("spend_ledger").values()].every(row => row.total === 0.1)).toBe(true);
  await expect(submitIllustration("world", "view", { ...illustrationInput, prompt: "Different appearance" })).rejects.toMatchObject({ status: 409 });
});
it("versioned illustrations bind visible identities to verified saved mask bytes", async () => {
  const { view } = await enableIllustrations();
  const object = { ...newComponent("building", 10, 10), id: "kettle", label: "Copper Kettle" };
  const scene = store("place_scenes").get("world:place")!;
  scene.definition.objects = [object];
  const sources = [{ scene_id: "scene", place_id: "place", revision: 1, definition: scene.definition, x: 0, z: 0 }];
  Object.assign(view, await bindings(db, "world", sources));
  view.objects = [{ object_id: "kettle", rgb: [100, 120, 140] }]; view.floor_id = null;
  const pixels = Buffer.alloc(256 * 256 * 4);
  for (let p = 0; p < pixels.length; p += 4) pixels.set([100, 120, 140, 255], p);
  const mask = await sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
  view.files.objects = { key: "identity-mask", bytes: mask.length, sha256: createHash("sha256").update(mask).digest("hex") };
  const oldRead = vi.mocked(getStoredBytes).getMockImplementation()!;
  vi.mocked(getStoredBytes).mockImplementation(async (key, ...args) => key === "identity-mask" ? { bytes: mask, contentType: "image/png" } : oldRead(key, ...args));
  store("place_views").set(view._id, view);
  const request = { ...illustrationInput, parameters: { prompt_version: "saved-camera-depth-identity-v2" } };
  provider.mockImplementation(async (url: string) => Response.json(url.endsWith("capabilities") ? { enabled: true, model: ILLUSTRATION_MODEL, reservation: 0.1, parameters: request.parameters } : { request_id: "identity-request", model: ILLUSTRATION_MODEL }));
  await expect(submitIllustration("world", "view", request)).rejects.toMatchObject({ status: 503 });
  expect(store("spend_ledger").size).toBe(0);
  store("generation_workers").get("worker")!.illustration_identity = true;
  store("generation_workers").set("old", { _id: "old", kind: "place-layout", illustration: true, last_seen: new Date() });
  await expect(submitIllustration("world", "view", request)).rejects.toMatchObject({ status: 503 });
  store("generation_workers").delete("old");
  await submitIllustration("world", "view", { ...request, scene_identity: { objects: [{ label: "Forged" }] } });
  mask[0] = mask[0]! ^ 1;
  await processNextAssetJob(db, "illustration");
  expect(submitted()).toHaveLength(0);
  expect(illustrationJob().status).toBe("scheduled");
  expect(illustrationJob().submission_token).toBeUndefined();
  mask[0] = mask[0]! ^ 1;
  illustrationJob().next_check = new Date(0);
  await processNextAssetJob(db, "illustration");
  const payload = JSON.parse(submitted()[0]![1].body);
  expect(payload.inputs.scene_identity.objects).toEqual([expect.objectContaining({ id: "kettle", label: "Copper Kettle", visible_pixels: 65536, center_percent: [50, 50] })]);
  expect(JSON.stringify(payload)).not.toContain("Forged");
  expect(illustrationJob().parameters).toEqual(request.parameters);
  expect(illustrationJob().view_dependency).toEqual(illustrationDependency(view));
});
it.each(["revision", "definition", "capture"])("refunds obsolete illustration %s inputs before generation", async change => {
  await enableIllustrations(); await submitIllustration("world", "view", illustrationInput);
  if (change === "revision") store("place_scenes").get("world:place")!.revision++;
  if (change === "definition") store("place_scenes").get("world:place")!.definition.label = "changed";
  if (change === "capture") store("place_views").get("world:view")!.request_sha256 = "changed";
  await processNextAssetJob(db, "illustration"); await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("cancelled"); expect(submitted()).toHaveLength(0);
  expect([...store("spend_ledger").values()].every(row => row.total === 0)).toBe(true);
});
it("keeps input-storage failures unsubmitted, cancellable and fully refundable", async () => {
  const { blobs } = await enableIllustrations(); await submitIllustration("world", "view", illustrationInput); blobs.delete("depth");
  await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("scheduled"); expect(illustrationJob().error).toContain("no generation submitted");
  expect(submitted()).toHaveLength(0);
  await illustrationAction("world", "view", { action: "cancel", id: "run1" });
  expect([...store("spend_ledger").values()].every(row => row.total === 0)).toBe(true);
});
it("rechecks geometry after input download and before the paid claim", async () => {
  await enableIllustrations(); await submitIllustration("world", "view", illustrationInput);
  const original = vi.mocked(getStoredBytes).getMockImplementation()!;
  vi.mocked(getStoredBytes).mockImplementation(async (...args) => { const result = await original(...args); store("place_scenes").get("world:place")!.revision++; return result; });
  await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("cancelled"); expect(submitted()).toHaveLength(0);
});
it("retains ambiguous illustration submissions without generating on retry, refresh or reload", async () => {
  await enableIllustrations(); await submitIllustration("world", "view", illustrationInput); provider.mockRejectedValue(new Error("Lost response"));
  await processNextAssetJob(db, "illustration"); expect(illustrationJob().status).toBe("submission_unknown");
  await submitIllustration("world", "view", illustrationInput); await illustrationAction("world", "view", { action: "refresh", id: "run1" });
  await illustrationLibrary("world", "view"); await processNextAssetJob(db, "illustration");
  expect(submitted()).toHaveLength(1);
});
it("stores a draft, accepts against current geometry, and preserves bytes when it becomes historical", async () => {
  await enableIllustrations(); await submitIllustration("world", "view", illustrationInput); await processNextAssetJob(db, "illustration");
  readyIllustration(); await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("ready");
  const asset = store("illustration_assets").get("world:illustration_run1")!;
  expect(asset.view_dependency).toEqual(illustrationJob().view_dependency);
  expect((await illustrationLibrary("world", "view")).assets[0]).toMatchObject({ accepted: false, historical: false });
  await illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: null });
  expect(store("place_scenes").get("world:place")!.revision).toBe(1);
  expect((await illustrationLibrary("world", "view")).assets[0]).toMatchObject({ accepted: true, historical: false });
  store("place_scenes").get("world:place")!.revision++;
  expect((await illustrationLibrary("world", "view")).assets[0]).toMatchObject({ accepted: true, historical: true });
  await expect(illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: asset.id })).rejects.toMatchObject({ status: 409 });
  expect(await meshBytes("world", asset.id, "illustration")).toEqual(fixtureMaterial()); expect(submitted()).toHaveLength(1);
});
it("rejects wrong-size illustration output and retries storage without another paid request", async () => {
  await enableIllustrations(); await submitIllustration("world", "view", illustrationInput); await processNextAssetJob(db, "illustration");
  const wrong = await sharp(fixtureMaterial()).resize(128, 128).jpeg().toBuffer();
  readyIllustration(wrong); await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("storage_failed"); expect(store("illustration_assets").size).toBe(0);
  readyIllustration(); await illustrationAction("world", "view", { action: "refresh", id: "run1" }); await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("ready"); expect(submitted()).toHaveLength(1);
});
it("retains late completed illustrations as historical drafts and rejects acceptance", async () => {
  await enableIllustrations(); await submitIllustration("world", "view", illustrationInput); await processNextAssetJob(db, "illustration");
  store("place_scenes").get("world:place")!.revision++;
  readyIllustration(); await processNextAssetJob(db, "illustration");
  expect((await illustrationLibrary("world", "view")).assets[0]).toMatchObject({ accepted: false, historical: true });
  await expect(illustrationAction("world", "view", { action: "accept", id: "illustration_run1", previous_id: null })).rejects.toMatchObject({ status: 409 });
});
it("does not publish an orientation-transformed result or regenerate on storage retry", async () => {
  await enableIllustrations(); await submitIllustration("world", "view", illustrationInput); await processNextAssetJob(db, "illustration");
  readyIllustration(await sharp(fixtureMaterial()).withMetadata({ orientation: 6 }).jpeg().toBuffer());
  await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("storage_failed"); expect(store("illustration_assets").size).toBe(0);
  await illustrationAction("world", "view", { action: "refresh", id: "run1" }); await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("storage_failed"); expect(submitted()).toHaveLength(1);
});
it("rejects orientation-transformed legacy artwork at acceptance", async () => {
  const { blobs } = await enableIllustrations(); await submitIllustration("world", "view", illustrationInput); await processNextAssetJob(db, "illustration");
  readyIllustration(); await processNextAssetJob(db, "illustration");
  const asset = store("illustration_assets").get("world:illustration_run1")!;
  const bytes = await sharp(fixtureMaterial()).withMetadata({ orientation: 2 }).jpeg().toBuffer();
  blobs.set(asset.key, bytes); asset.bytes = bytes.length; asset.sha256 = createHash("sha256").update(bytes).digest("hex");
  await expect(illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: null })).rejects.toMatchObject({ status: 400 });
  expect(store("place_views").get("world:view")!.accepted_illustration_id).toBeUndefined(); expect(submitted()).toHaveLength(1);
});
it("rejects unowned illustration operations without provider calls", async () => {
  await enableIllustrations(); memory.owner = false;
  for (const action of [() => submitIllustration("world", "view", illustrationInput), () => illustrationLibrary("world", "view"), () => illustrationAction("world", "view", { action: "refresh", id: "run1" })]) await expect(action()).rejects.toMatchObject({ status: 403 });
  expect(provider).not.toHaveBeenCalled();
});

async function regionFixture() {
  const context = await enableIllustrations(), { view, blobs } = context;
  view.objects = [{ object_id: "roof", rgb: [1, 2, 3] }, { object_id: "wall", rgb: [4, 5, 6] }];
  const pixels = Buffer.alloc(256 * 256 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(i < pixels.length / 2 ? [1, 2, 3, 255] : [4, 5, 6, 255], i);
  const mask = await sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
  blobs.set("objects", mask); view.files.objects = { key: "objects", sha256: createHash("sha256").update(mask).digest("hex"), bytes: mask.length };
  await submitIllustration("world", "view", illustrationInput); await processNextAssetJob(db, "illustration");
  readyIllustration(await sharp(context.png).modulate({ brightness: 0.5 }).jpeg().toBuffer()); await processNextAssetJob(db, "illustration");
  return { ...context, request: { action: "compose", id: "edit1", proposal_id: "illustration_run1", base_id: null, object_ids: ["roof"] } };
}
async function refreshFixture() {
  const context = await regionFixture(), { view, blobs, png } = context;
  view.depth = { encoding: "linear_view_z_8bit_near_white", near: 1, far: 10 };
  view.camera = { projection: "perspective", world_matrix: [], projection_matrix: [], near: 0.1, far: 100 };
  const before = { ...structuredClone(view), _id: "world:previous", id: "previous", accepted_illustration_id: "illustration_run1" };
  store("place_views").set(before._id, before);
  const base = store("illustration_assets").get("world:illustration_run1")!; base.view_dependency = illustrationDependency(before);
  view.refreshed_from = before.id; view.sources[0]!.revision = 2; store("place_scenes").get("world:place")!.revision = 2;
  const render = await registeredPixels(png, 256, 256); render.set([50, 70, 90, 255], (16 * 256 + 16) * 4);
  const changed = await sharp(render, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
  blobs.set("changed-render", changed); view.files.render = { key: "changed-render", sha256: createHash("sha256").update(changed).digest("hex"), bytes: changed.length };
  blobs.set("new-proposal", png);
  store("illustration_assets").set("world:new", { ...structuredClone(base), _id: "world:new", id: "new", key: "new-proposal", content_type: "image/png", sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length, view_dependency: illustrationDependency(view) });
  return { ...context, before, base, request: { action: "compose_refresh", id: "update", proposal_id: "new", base_id: base.id, previous_id: null } };
}
it("refreshes current geometry over historical artwork without touching old assets, scene or protected pixels", async () => {
  const { request, before, base } = await refreshFixture(), old = structuredClone(before), scene = structuredClone(store("place_scenes").get("world:place")!);
  const calls = provider.mock.calls.length;
  expect(await illustrationAction("world", "view", request)).toEqual({ id: "refresh_update" });
  const asset = store("illustration_assets").get("world:refresh_update")!;
  expect(asset.geometry_refresh).toMatchObject({ base_id: base.id, base_view: { view_id: before.id }, changed_pixels: 25, protected_pixels: 65511 });
  const original = await registeredPixels(await meshBytes("world", base.id, "illustration"), 256, 256), output = await registeredPixels(await meshBytes("world", asset.id, "illustration"), 256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (x < 14 || x > 18 || y < 14 || y > 18) {
    const offset = (y * 256 + x) * 4; expect(output.subarray(offset, offset + 4)).toEqual(original.subarray(offset, offset + 4));
  }
  expect(output).not.toEqual(original);
  await illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: null });
  await illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: null });
  expect(store("place_views").get(before._id)).toEqual(old);
  expect(store("place_scenes").get("world:place")!.definition).toEqual(scene.definition); expect(store("place_scenes").get("world:place")!.revision).toBe(2);
  expect(provider.mock.calls.length).toBe(calls);
  expect((await illustrationLibrary("world", "view")).assets.find(a => a.id === asset.id)!.geometry_refresh).toEqual(asset.geometry_refresh);
});
it("replays a lost refresh acknowledgement after acceptance or stale geometry without uploading twice", async () => {
  const { request } = await refreshFixture(); await Promise.all([illustrationAction("world", "view", request), illustrationAction("world", "view", request)]);
  const uploads = vi.mocked(uploadJpeg).mock.calls.length;
  await illustrationAction("world", "view", { action: "accept", id: "refresh_update", previous_id: null });
  store("place_scenes").get("world:place")!.revision++;
  expect(await illustrationAction("world", "view", request)).toEqual({ id: "refresh_update" });
  expect(vi.mocked(uploadJpeg)).toHaveBeenCalledTimes(uploads);
  await expect(illustrationAction("world", "view", { ...request, previous_id: "new" })).rejects.toMatchObject({ status: 409 });
});
it("uses the predecessor render when no artwork was accepted and preserves that base receipt", async () => {
  const { request, before } = await refreshFixture(); Reflect.deleteProperty(before, "accepted_illustration_id");
  await illustrationAction("world", "view", { ...request, base_id: null });
  const asset = store("illustration_assets").get("world:refresh_update")!;
  expect(asset.geometry_refresh).toMatchObject({ base_id: null, base_sha256: before.files.render.sha256, base_view: { view_id: before.id } });
  await illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: null });
  expect(store("place_views").get("world:view")!.accepted_illustration_id).toBe(asset.id);
  expect(before.accepted_illustration_id).toBeUndefined();
});
it.each(["edit_input", "region_edit", "geometry_refresh"])("rejects a partial %s proposal for a geometry refresh", async kind => {
  const { request } = await refreshFixture(); store("illustration_assets").get("world:new")![kind] = {};
  const uploads = vi.mocked(uploadJpeg).mock.calls.length;
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 409 });
  expect(vi.mocked(uploadJpeg)).toHaveBeenCalledTimes(uploads);
});
it.each(["revision", "predecessor", "destination"])("rejects a concurrent %s change during refresh publication", async change => {
  const { request } = await refreshFixture(), upload = vi.mocked(uploadJpeg).getMockImplementation()!;
  vi.mocked(uploadJpeg).mockImplementation(async (...args) => {
    const result = await upload(...args);
    if (change === "revision") store("place_scenes").get("world:place")!.revision++;
    else store("place_views").get(change === "predecessor" ? "world:previous" : "world:view")!.accepted_illustration_id = "new";
    return result;
  });
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 409 });
  expect(store("illustration_assets").has("world:refresh_update")).toBe(false);
});
it("rejects foreign inputs, changed framing, missing bytes and stale refresh acceptance", async () => {
  const { request, view, blobs } = await refreshFixture();
  memory.owner = false; await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 403 }); memory.owner = true;
  await expect(illustrationAction("world", "view", { ...request, proposal_id: "foreign" })).rejects.toMatchObject({ status: 409 });
  view.camera.far++; await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 409 }); view.camera.far--;
  const old = blobs.get("render")!; blobs.delete("render"); await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 503 }); blobs.set("render", old);
  await illustrationAction("world", "view", request);
  await illustrationAction("world", "view", { action: "accept", id: "new", previous_id: null });
  await expect(illustrationAction("world", "view", { action: "accept", id: "refresh_update", previous_id: "new" })).rejects.toMatchObject({ status: 409 });
});
it("counts refresh composites against the shared edit and generation capacity", async () => {
  const { request } = await refreshFixture();
  for (let i = 0; i < 50; i++) store("illustration_assets").set(`world:refresh_${i}`, { _id: `world:refresh_${i}`, session_id: "world", geometry_refresh: {}, view_dependency: { view_id: "view" } });
  const uploads = vi.mocked(uploadJpeg).mock.calls.length;
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 409 });
  expect(vi.mocked(uploadJpeg)).toHaveBeenCalledTimes(uploads);
});
it("publishes an immutable region preview, preserving outside pixels, then explicitly accepts without generation", async () => {
  const { view, png, request } = await regionFixture(), before = structuredClone(store("place_scenes").get("world:place")!.definition);
  const calls = provider.mock.calls.length;
  expect(await illustrationAction("world", "view", request)).toEqual({ id: "region_edit1" });
  expect(view.accepted_illustration_id).toBeUndefined();
  const asset = store("illustration_assets").get("world:region_edit1")!;
  expect(asset).toMatchObject({ content_type: "image/png", view_dependency: illustrationDependency(view), region_edit: { proposal_id: "illustration_run1", base_id: null, object_ids: ["roof"], selected_pixels: 32768, protected_pixels: 32768 } });
  const original = await registeredPixels(png, 256, 256), composed = await registeredPixels(await meshBytes("world", asset.id, "illustration"), 256, 256);
  expect(composed.subarray(composed.length / 2)).toEqual(original.subarray(original.length / 2)); expect(composed.subarray(0, 1024)).not.toEqual(original.subarray(0, 1024));
  await illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: null });
  await illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: null });
  expect(store("place_views").get("world:view")!.accepted_illustration_id).toBe(asset.id);
  expect(store("place_scenes").get("world:place")!.definition).toEqual(before); expect(store("place_scenes").get("world:place")!.revision).toBe(1);
  expect(provider.mock.calls.length).toBe(calls);
});
it("replays region requests after lost responses and stale geometry without publishing twice", async () => {
  const { request } = await regionFixture(); await Promise.all([illustrationAction("world", "view", request), illustrationAction("world", "view", request)]);
  expect(store("illustration_assets").size).toBe(2); const uploads = vi.mocked(uploadJpeg).mock.calls.length;
  store("place_scenes").get("world:place")!.revision++;
  expect(await illustrationAction("world", "view", request)).toEqual({ id: "region_edit1" }); expect(vi.mocked(uploadJpeg)).toHaveBeenCalledTimes(uploads);
  await expect(illustrationAction("world", "view", { ...request, object_ids: ["wall"] })).rejects.toMatchObject({ status: 409 });
});
it("chains region previews onto accepted PNG artwork and retains source lineage", async () => {
  const { request } = await regionFixture(); await illustrationAction("world", "view", request);
  await illustrationAction("world", "view", { action: "accept", id: "region_edit1", previous_id: null });
  await illustrationAction("world", "view", { ...request, id: "edit2", base_id: "region_edit1", object_ids: ["wall"] });
  const asset = store("illustration_assets").get("world:region_edit2")!;
  expect(asset.region_edit.base_sha256).toBe(store("illustration_assets").get("world:region_edit1")!.sha256);
  const before = await registeredPixels(await meshBytes("world", "region_edit1", "illustration"), 256, 256);
  const after = await registeredPixels(await meshBytes("world", "region_edit2", "illustration"), 256, 256);
  expect(after.subarray(0, after.length / 2)).toEqual(before.subarray(0, before.length / 2));
});
it.each(["revision", "acceptance"])("rejects a concurrent %s change during region upload without publishing", async change => {
  const { request } = await regionFixture(), upload = vi.mocked(uploadJpeg).getMockImplementation()!;
  vi.mocked(uploadJpeg).mockImplementation(async (...args) => {
    const result = await upload(...args);
    if (change === "revision") store("place_scenes").get("world:place")!.revision++;
    else store("place_views").get("world:view")!.accepted_illustration_id = "illustration_run1";
    return result;
  });
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 409 }); expect(store("illustration_assets").size).toBe(1);
});
it("rejects a region preview when accepted artwork changes before review acceptance", async () => {
  const { request } = await regionFixture(); await illustrationAction("world", "view", request);
  await illustrationAction("world", "view", { action: "accept", id: "illustration_run1", previous_id: null });
  await expect(illustrationAction("world", "view", { action: "accept", id: "region_edit1", previous_id: "illustration_run1" })).rejects.toMatchObject({ status: 409 });
  expect(store("place_views").get("world:view")!.accepted_illustration_id).toBe("illustration_run1");
});
it.each(["mask", "base", "proposal"])("fails closed for missing or corrupted region %s bytes", async missing => {
  const { request, blobs } = await regionFixture();
  if (missing === "mask") blobs.delete("objects");
  else if (missing === "base") blobs.set("render", Buffer.from("corrupt"));
  else blobs.delete(store("illustration_assets").get("world:illustration_run1")!.key);
  const uploads = vi.mocked(uploadJpeg).mock.calls.length;
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 503 });
  expect(vi.mocked(uploadJpeg)).toHaveBeenCalledTimes(uploads); expect(store("illustration_assets").size).toBe(1);
});
it("retries region storage failures with no new model calls", async () => {
  const { request } = await regionFixture(), upload = vi.mocked(uploadJpeg).getMockImplementation()!, calls = provider.mock.calls.length;
  vi.mocked(uploadJpeg).mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(illustrationAction("world", "view", request)).rejects.toThrow("Storage unavailable"); expect(store("illustration_assets").size).toBe(1);
  vi.mocked(uploadJpeg).mockImplementation(upload); await illustrationAction("world", "view", request);
  expect(provider.mock.calls.length).toBe(calls); expect(store("illustration_assets").size).toBe(2);
});
it("rejects cross-camera, cross-owner, malformed and stale-base region requests", async () => {
  const { request } = await regionFixture();
  for (const changed of [{ ...request, proposal_id: "other_owner" }, { ...request, id: "../bad" }, { ...request, object_ids: ["unregistered"] }, { ...request, base_id: "old" }]) await expect(illustrationAction("world", "view", changed)).rejects.toBeInstanceOf(Error);
  const proposal = store("illustration_assets").get("world:illustration_run1")!; proposal.view_dependency.view_id = "other_view";
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 409 });
  memory.owner = false; await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 403 });
  expect(store("illustration_assets").size).toBe(1);
});
it("bounds combined illustration jobs and local region edits before upload or reservation", async () => {
  const { request } = await regionFixture();
  for (let i = 0; i < 49; i++) store("illustration_assets").set(`world:region_${i}`, { _id: `world:region_${i}`, session_id: "world", region_edit: {}, view_dependency: { view_id: "view" } });
  const uploads = vi.mocked(uploadJpeg).mock.calls.length;
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 409 }); expect(vi.mocked(uploadJpeg)).toHaveBeenCalledTimes(uploads);
  provider.mockImplementation(async () => Response.json({ enabled: true, model: ILLUSTRATION_MODEL, reservation: 0.1, parameters: illustrationInput.parameters }));
  await expect(submitIllustration("world", "view", { ...illustrationInput, id: "extra" })).rejects.toMatchObject({ status: 409 });
  expect(store("illustration_jobs").size).toBe(1); expect([...store("spend_ledger").values()].every(row => row.total === 0.1)).toBe(true);
});

async function maskedFixture() {
  const context = await regionFixture(); await illustrationAction("world", "view", context.request);
  await illustrationAction("world", "view", { action: "accept", id: "region_edit1", previous_id: null });
  const request = { ...illustrationInput, action: "generate_region", id: "masked1", model: ILLUSTRATION_EDIT_MODEL, prompt: "Add blue roof tiles", base_id: "region_edit1", object_ids: ["roof"] };
  provider.mockImplementation(async (url: string) => Response.json(url.endsWith("capabilities") ? { enabled: true, model: url.endsWith("region-capabilities") ? ILLUSTRATION_EDIT_MODEL : ILLUSTRATION_MODEL, reservation: 0.1, parameters: request.parameters } : { request_id: "masked-request", model: ILLUSTRATION_EDIT_MODEL }));
  return { ...context, request };
}
it("reserves masked intent once and submits the accepted artwork, exact mask and original depth", async () => {
  const { request, png } = await maskedFixture();
  await Promise.all([illustrationAction("world", "view", request), illustrationAction("world", "view", request)]);
  const saved = store("illustration_jobs").get("world:masked1")!; expect(saved.edit_input.base_id).toBe("region_edit1");
  expect(store("illustration_jobs").size).toBe(2); expect([...store("spend_ledger").values()].every(row => row.total === 0.2)).toBe(true);
  await processNextAssetJob(db, "illustration");
  const posts = submitted(); expect(posts).toHaveLength(2); const payload = JSON.parse(posts[1]![1].body);
  expect(payload.model).toBe(ILLUSTRATION_EDIT_MODEL);
  const bytes = (url: string) => Buffer.from(url.split(",")[1]!, "base64");
  const base = await meshBytes("world", "region_edit1", "illustration");
  expect(await registeredPixels(bytes(payload.inputs.image_url), 256, 256)).toEqual(await registeredPixels(base, 256, 256));
  expect(bytes(payload.inputs.control_lora_image_url)).toEqual(png);
  const mask = await sharp(bytes(payload.inputs.mask_url)).removeAlpha().raw().toBuffer();
  expect(mask.subarray(0, mask.length / 2).every(v => v === 255)).toBe(true); expect(mask.subarray(mask.length / 2).every(v => v === 0)).toBe(true);
  await expect(illustrationAction("world", "view", { ...request, object_ids: ["wall"] })).rejects.toMatchObject({ status: 409 });
});
it("retains freehand intent across queueing, recovery, protected composition and acceptance", async () => {
  const { request } = await maskedFixture(); store("generation_workers").get("worker")!.illustration_brush = true;
  const brush_strokes = [{ operation: "paint", radius: 3, points: [[10, 10]] }];
  const intent = { ...request, brush_strokes };
  await illustrationAction("world", "view", intent); await illustrationAction("world", "view", intent);
  expect(store("illustration_jobs").get("world:masked1")!.edit_input.brush_strokes).toEqual(brush_strokes);
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 409 });
  await processNextAssetJob(db, "illustration");
  const payload = JSON.parse(submitted()[1]![1].body);
  const mask = await sharp(Buffer.from(payload.inputs.mask_url.split(",")[1], "base64")).greyscale().raw().toBuffer();
  expect(mask.filter(v => v === 255)).toHaveLength(29);
  readyIllustration(); await processNextAssetJob(db, "illustration");
  const proposal = store("illustration_assets").get("world:illustration_masked1")!;
  expect(proposal.edit_input.brush_strokes).toEqual(brush_strokes);
  const preview = { action: "compose", id: "brush", proposal_id: proposal.id, base_id: request.base_id, object_ids: request.object_ids, brush_strokes };
  await expect(illustrationAction("world", "view", { ...preview, brush_strokes: undefined })).rejects.toMatchObject({ status: 409 });
  await illustrationAction("world", "view", preview); await illustrationAction("world", "view", preview);
  expect(store("illustration_assets").get("world:region_brush")!.region_edit).toMatchObject({ brush_strokes, selected_pixels: 29, method: "object_clipped_brush_rgba_v1" });
  await illustrationAction("world", "view", { action: "accept", id: "region_brush", previous_id: request.base_id });
  expect(submitted()).toHaveLength(2); expect(store("place_scenes").get("world:place")!.revision).toBe(1);
});
it("fails closed before charging for empty strokes or a mixed-version brush worker set", async () => {
  const { request } = await maskedFixture(); store("generation_workers").get("worker")!.illustration_brush = true;
  await expect(illustrationAction("world", "view", { ...request, brush_strokes: [] })).rejects.toThrow("no visible pixels");
  store("generation_workers").set("legacy", { _id: "legacy", kind: "place-layout", illustration: true, illustration_region: true, last_seen: new Date() });
  const intent = { ...request, brush_strokes: [{ operation: "paint", radius: 3, points: [[10, 10]] }] };
  await expect(illustrationAction("world", "view", intent)).rejects.toMatchObject({ status: 503 });
  expect((await illustrationLibrary("world", "view")).region_capabilities).toMatchObject({ enabled: true, brush_enabled: false });
  expect(store("illustration_jobs").size).toBe(1); expect(submitted()).toHaveLength(1);
  store("generation_workers").delete("legacy");
  expect((await illustrationLibrary("world", "view")).region_capabilities.brush_enabled).toBe(true);
});
it("narrows an existing whole-object masked proposal with a local brush without another generation", async () => {
  const { request } = await maskedFixture(); await illustrationAction("world", "view", request); await processNextAssetJob(db, "illustration");
  readyIllustration(); await processNextAssetJob(db, "illustration"); const calls = submitted().length;
  const input = { action: "compose", id: "narrow", proposal_id: "illustration_masked1", base_id: request.base_id, object_ids: request.object_ids,
    brush_strokes: [{ operation: "paint", radius: 2, points: [[10, 10]] }] };
  await illustrationAction("world", "view", input);
  expect(store("illustration_assets").get("world:region_narrow")!.region_edit).toMatchObject({ selected_pixels: 13, brush_strokes: input.brush_strokes });
  await expect(illustrationAction("world", "view", { ...input, id: "wrong", object_ids: ["wall"] })).rejects.toMatchObject({ status: 409 });
  expect(submitted()).toHaveLength(calls);
});
it.each(["base", "geometry", "mask"])("refunds a masked job with changed %s before submission", async change => {
  const { request } = await maskedFixture(); await illustrationAction("world", "view", request);
  if (change === "base") store("place_views").get("world:view")!.accepted_illustration_id = "illustration_run1";
  if (change === "geometry") store("place_scenes").get("world:place")!.revision++;
  if (change === "mask") store("place_views").get("world:view")!.files.objects.sha256 = "changed";
  await processNextAssetJob(db, "illustration"); await processNextAssetJob(db, "illustration");
  expect(store("illustration_jobs").get("world:masked1")!.status).toBe("cancelled"); expect(submitted()).toHaveLength(1);
  expect([...store("spend_ledger").values()].every(row => row.total === 0.1)).toBe(true);
});
it("checks accepted artwork again after input reads and before claiming the paid POST", async () => {
  const { request } = await maskedFixture(); await illustrationAction("world", "view", request);
  const read = vi.mocked(getStoredBytes).getMockImplementation()!;
  vi.mocked(getStoredBytes).mockImplementation(async (...args) => { const bytes = await read(...args); store("place_views").get("world:view")!.accepted_illustration_id = "illustration_run1"; return bytes; });
  await processNextAssetJob(db, "illustration"); expect(submitted()).toHaveLength(1); expect(store("illustration_jobs").get("world:masked1")!.status).toBe("cancelled");
});
it("keeps missing masked input unsubmitted, and rejects missing inputs before reservation", async () => {
  const { request, blobs } = await maskedFixture(); const mask = blobs.get("objects")!; blobs.delete("objects");
  await expect(illustrationAction("world", "view", request)).rejects.toThrow(); expect(store("illustration_jobs").size).toBe(1);
  blobs.set("objects", mask); await illustrationAction("world", "view", request); blobs.delete("objects");
  await processNextAssetJob(db, "illustration"); expect(store("illustration_jobs").get("world:masked1")!.status).toBe("scheduled"); expect(submitted()).toHaveLength(1);
  await illustrationAction("world", "view", { action: "cancel", id: "masked1" }); expect([...store("spend_ledger").values()].every(row => row.total === 0.1)).toBe(true);
});
it("retains ambiguous masked intent and never resubmits on an identical retry", async () => {
  const { request } = await maskedFixture(); await illustrationAction("world", "view", request); provider.mockRejectedValue(new Error("Lost provider response"));
  await processNextAssetJob(db, "illustration"); expect(store("illustration_jobs").get("world:masked1")!.status).toBe("submission_unknown");
  await illustrationAction("world", "view", request); await processNextAssetJob(db, "illustration"); expect(submitted()).toHaveLength(2);
});
it("recovers masked results through the saved model and requires a protected composite before acceptance", async () => {
  const { request } = await maskedFixture(); await illustrationAction("world", "view", request); await processNextAssetJob(db, "illustration");
  readyIllustration(); await processNextAssetJob(db, "illustration");
  expect(provider.mock.calls.some(([url]) => url.includes(`/requests/masked-request?model=${encodeURIComponent(ILLUSTRATION_EDIT_MODEL)}`))).toBe(true);
  const asset = store("illustration_assets").get("world:illustration_masked1")!;
  expect(asset.edit_input).toEqual(store("illustration_jobs").get("world:masked1")!.edit_input);
  await expect(illustrationAction("world", "view", { action: "accept", id: asset.id, previous_id: "region_edit1" })).rejects.toMatchObject({ status: 409 });
  await expect(illustrationAction("world", "view", { action: "compose", id: "wrong", proposal_id: asset.id, base_id: "region_edit1", object_ids: ["wall"] })).rejects.toMatchObject({ status: 409 });
  await illustrationAction("world", "view", { action: "compose", id: "masked_preview", proposal_id: asset.id, base_id: "region_edit1", object_ids: ["roof"] });
  await illustrationAction("world", "view", { action: "accept", id: "region_masked_preview", previous_id: "region_edit1" });
  expect(submitted()).toHaveLength(2); expect(store("place_scenes").get("world:place")!.revision).toBe(1);
});
it("rejects unconsented, mismatched-model, foreign and stale-base masked intent without a new reservation", async () => {
  const { request } = await maskedFixture();
  for (const input of [{ ...request, confirmed: false }, { ...request, action: "generate" }, { ...request, model: ILLUSTRATION_MODEL }, { ...request, base_id: "foreign" }, { ...request, base_id: null }, { ...request, object_ids: ["unknown"] }]) await expect(illustrationAction("world", "view", input)).rejects.toBeInstanceOf(Error);
  expect(store("illustration_jobs").size).toBe(1); expect(submitted()).toHaveLength(1);
});
it("does not reserve masked work for an older illustration worker", async () => {
  const { request } = await maskedFixture(); delete store("generation_workers").get("worker")!.illustration_region;
  await expect(illustrationAction("world", "view", request)).rejects.toMatchObject({ status: 503 });
  expect(store("illustration_jobs").size).toBe(1); expect((await illustrationLibrary("world", "view")).region_capabilities.enabled).toBe(false);
});

import { KEYFRAME_MODEL } from "./asset-pipeline";
const keyframeParameters = { num_images: 2, prompt_version: "saved-camera-qwen-keyframe-v1" };
const keyframeRequest = { id: "run1", action: "generate_keyframe", prompt: "Inked stone, warm light", confirmed: true, model: KEYFRAME_MODEL, reservation: 0.1, parameters: keyframeParameters };
const fal = (n: number) => `https://v3.fal.media/files/candidate${n}.jpg`;
const solid = (r: number, g: number, b: number) => sharp({ create: { width: 256, height: 256, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const gateCalls = () => provider.mock.calls.filter(([url]) => url.endsWith("/illustration/gate"));
// Mask PNG of the square [78, 178) that the object pass gives the building.
async function squareMask() {
  const pixels = Buffer.alloc(256 * 256);
  for (let y = 78; y < 178; y++) pixels.fill(255, y * 256 + 78, y * 256 + 178);
  return (await sharp(pixels, { raw: { width: 256, height: 256, channels: 1 } }).png().toBuffer()).toString("base64");
}
async function enableKeyframes() {
  const { view, blobs } = await enableIllustrations();
  store("generation_workers").get("worker")!.illustration_keyframe = true;
  const scene = store("place_scenes").get("world:place")!;
  scene.definition = { ...emptyPlaceScene(), width: 20, depth: 20, objects: [{ ...newComponent("building", 10, 10), id: "kettle", label: "Copper Kettle" }] };
  scene.source_image_key = "art"; blobs.set("art", await solid(200, 40, 40));
  Object.assign(view, await bindings(db, "world", [{ scene_id: "scene", place_id: "place", revision: 1, definition: scene.definition, x: 0, z: 0 }] as never));
  const f = 1 / Math.tan(25 * Math.PI / 180);
  view.camera = { projection: "perspective", world_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], projection_matrix: [f, 0, 0, 0, 0, f, 0, 0, 0, 0, -100.1 / 99.9, -1, 0, 0, -20 / 99.9, 0], near: 0.1, far: 100 };
  view.depth = { encoding: "linear_view_z_8bit_near_white", near: 1, far: 50 }; view.label = "Front";
  view.objects = [{ object_id: "kettle", rgb: [100, 120, 140] }]; view.floor_id = null;
  const objects = Buffer.alloc(256 * 256 * 4), depth = Buffer.alloc(256 * 256 * 4);
  for (let p = 0; p < 256 * 256; p++) {
    const x = p % 256, y = Math.floor(p / 256), inside = x >= 78 && x < 178 && y >= 78 && y < 178;
    objects.set(inside ? [100, 120, 140, 255] : [0, 0, 0, 255], p * 4);
    depth.set(y < 20 ? [0, 0, 0, 255] : [200, 200, 200, 255], p * 4); // a band of sky over a wall 11.6 m away
  }
  for (const [pass, raw] of [["objects", objects], ["depth", depth]] as const) {
    const png = await sharp(raw, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
    blobs.set(pass, png); view.files[pass] = { key: pass, sha256: sha(png), bytes: png.length };
  }
  store("place_views").set(view._id, view);
  const state = { status: { status: "running" } as object, gate: async () => Response.json({ masks: [{ mask_png: await squareMask(), request_id: "sam1", score: 0.9 }, { mask_png: null, request_id: "sam2", score: null }] }),
    candidates: [await solid(30, 60, 220), await solid(40, 200, 60)], broken: false };
  provider.mockImplementation(async (url: string) => {
    if (url.endsWith("/keyframe-capabilities")) return Response.json({ enabled: true, model: KEYFRAME_MODEL, reservation: 0.1, parameters: keyframeParameters });
    if (url.endsWith("capabilities")) return Response.json({ enabled: false, model: ILLUSTRATION_MODEL, reservation: 0.1, parameters: {} });
    if (url.endsWith("/submit")) return Response.json({ request_id: "keyframe-request", model: KEYFRAME_MODEL });
    if (url.includes("/requests/")) return Response.json(state.status);
    if (url.endsWith("/illustration/gate")) return state.gate();
    const n = [fal(0), fal(1)].indexOf(url);
    return n < 0 || state.broken && n === 0 ? new Response(null, { status: 500 }) : new Response(new Uint8Array(state.candidates[n]!));
  });
  const ready = () => { state.status = { status: "ready", image: { url: fal(0) }, images: [{ url: fal(0) }, { url: fal(1) }] }; };
  return { view, blobs, state, ready };
}
it("paints a first keyframe from the world's art, gates once before download and keeps the gate on storage retry", async () => {
  const { blobs, state, ready } = await enableKeyframes();
  await Promise.all([submitIllustration("world", "view", keyframeRequest), illustrationAction("world", "view", keyframeRequest)]);
  expect(store("illustration_jobs").size).toBe(1); expect([...store("spend_ledger").values()].every(row => row.total === 0.1)).toBe(true);
  await expect(submitIllustration("world", "view", { ...keyframeRequest, art: false })).rejects.toMatchObject({ status: 409 });
  expect(illustrationJob().keyframe_input).toEqual({ stage: "first", art: "art", reference: { key: "art", sha256: sha(blobs.get("art")!) }, gate_object_id: "kettle" });
  await processNextAssetJob(db, "illustration");
  const { inputs } = JSON.parse(submitted()[0]![1].body);
  expect(inputs).toMatchObject({ keyframe_stage: "first", image_size: { width: 256, height: 256 }, image_url: `data:image/png;base64,${blobs.get("render")!.toString("base64")}` });
  expect(inputs.reference_url).toMatch(/^data:image\/jpeg;base64,/); expect(inputs.control_lora_image_url).toBeUndefined();
  expect(inputs.scene_identity.objects).toEqual([expect.objectContaining({ id: "kettle", label: "Copper Kettle" })]);
  ready(); state.broken = true; await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("storage_failed"); expect(illustrationJob().keyframe_gate).toMatchObject({ status: "measured" });
  expect(gateCalls()).toHaveLength(1);
  expect(JSON.parse(gateCalls()[0]![1].body)).toEqual({ image_urls: [fal(0), fal(1)], box: [78, 78, 178, 178], width: 256, height: 256, label: "building" });
  expect(provider.mock.calls.some(([url]) => url.includes(`/requests/keyframe-request?model=${encodeURIComponent(KEYFRAME_MODEL)}`))).toBe(true);
  state.broken = false; await illustrationAction("world", "view", { action: "refresh", id: "run1" }); await processNextAssetJob(db, "illustration");
  expect(illustrationJob().status).toBe("ready"); expect(gateCalls()).toHaveLength(1); expect(submitted()).toHaveLength(1);
  const asset = store("illustration_assets").get("world:illustration_run1")!;
  expect(asset.keyframe).toMatchObject({ version: 1, stage: "first", art: "art", reference: { key: "art" }, object_id: "kettle", gate: "passed", chosen: 0, passed: true, sky_pinned: false });
  expect(asset.keyframe.candidates).toEqual([expect.objectContaining({ iou: 1, centre_dx: 0, area_ratio: 1, passed: true }), expect.objectContaining({ iou: null, passed: false })]);
  expect(asset.keyframe.candidates[0].painted).toBeGreaterThan(12);
  expect(blobs.get(asset.key)).toEqual(state.candidates[0]);
  expect((await illustrationLibrary("world", "view")).assets[0]!.keyframe).toMatchObject({ gate: "passed", chosen: 0 });
});
it.each(["outage", "interrupted"])("stores candidate 0 as unmeasured after a gate %s without segmenting again", async kind => {
  const { state, ready } = await enableKeyframes();
  state.gate = async () => new Response("Keyframe gate segmenter failed", { status: 502 });
  await submitIllustration("world", "view", keyframeRequest); await processNextAssetJob(db, "illustration");
  if (kind === "interrupted") illustrationJob().keyframe_gate = { status: "started" };
  ready(); await processNextAssetJob(db, "illustration");
  expect(illustrationJob()).toMatchObject({ status: "ready", keyframe_gate: { status: "outage" } });
  expect(gateCalls()).toHaveLength(kind === "outage" ? 1 : 0);
  expect(store("illustration_assets").get("world:illustration_run1")!.keyframe).toMatchObject({ gate: "unmeasured", chosen: 0, passed: false,
    candidates: [expect.objectContaining({ iou: null, passed: false }), expect.objectContaining({ iou: null, passed: false })] });
});
it("refuses to continue from a camera without accepted artwork before any reservation", async () => {
  const { view } = await enableKeyframes();
  store("place_views").set("world:other", { ...structuredClone(view), _id: "world:other", id: "other" });
  await expect(submitIllustration("world", "view", { ...keyframeRequest, chain_from: "other" })).rejects.toMatchObject({ status: 409 });
  await expect(submitIllustration("world", "view", { ...keyframeRequest, chain_from: "missing" })).rejects.toMatchObject({ status: 404 });
  await expect(submitIllustration("world", "view", { ...keyframeRequest, chain_from: "other", art: false })).rejects.toMatchObject({ status: 400 });
  await expect(submitIllustration("world", "view", { ...keyframeRequest, action: "generate" })).rejects.toMatchObject({ status: 400 });
  expect(store("spend_ledger").size).toBe(0); expect(store("illustration_jobs").size).toBe(0);
});
it("chains from a walk camera of a connected place into an orbit camera through the depth warp and pins the warped sky", async () => {
  const { view, blobs, ready } = await enableKeyframes();
  // A place to the west: walk views draw the root place at its chunk offset, orbit views at the origin.
  const place = store("place_scenes").get("world:place")!, next = { ...structuredClone(place), _id: "world:next", id: "scene_next", place_id: "next", source_image_key: null, definition: { ...place.definition, objects: [] } };
  const geos = sceneGeos(place as never, []); geos.push(adjacentPlacement(place as never, next as never, "west", geos));
  store("place_scenes").set(next._id, next); store("world_map").set("world", { _id: "world", entities: geos });
  store("place_connections").set("world:link", { _id: "world:link", session_id: "world", id: "link", version: 1, kind: "boundary", a: { place_id: "place", side: "west", offset: 10 }, b: { place_id: "next", side: "east", offset: 10 }, width: 3, created_at: new Date(0).toISOString() });
  const sources = await currentSources(db, "world", "place", "walk"), root = sources.find(s => s.place_id === "place")!;
  expect(root.x).toBe(20);
  // Camera A stands 1 m left of camera B in the place's own frame, so B sees 24 px A never saw on the right.
  const previous = await solid(200, 40, 40), from = { ...structuredClone(view), _id: "world:front", id: "front", mode: "walk" as const, accepted_illustration_id: "illustration_prev", ...await bindings(db, "world", sources) };
  from.camera.world_matrix[12] = root.x - 1; from.camera.world_matrix[14] = root.z;
  store("place_views").set(from._id, from); blobs.set("prev", previous);
  store("illustration_assets").set("world:illustration_prev", { _id: "world:illustration_prev", id: "illustration_prev", session_id: "world", key: "prev", sha256: sha(previous), bytes: previous.length,
    model: KEYFRAME_MODEL, prompt: "Inked", created_at: new Date(), view_dependency: illustrationDependency(from) });
  expect((await illustrationLibrary("world", "view")).chain_sources).toEqual([{ view_id: "front", label: "Front" }]);
  await submitIllustration("world", "view", { ...keyframeRequest, chain_from: "front" });
  expect(illustrationJob().keyframe_input).toEqual({ stage: "chain", chain_from: { view_id: "front", illustration_id: "illustration_prev", sha256: sha(previous) }, gate_object_id: "kettle" });
  await processNextAssetJob(db, "illustration");
  const { inputs } = JSON.parse(submitted()[0]![1].body);
  expect(inputs.keyframe_stage).toBe("chain"); expect(inputs.reference_url).toMatch(/^data:image\/jpeg;base64,/);
  // The warp carries the accepted red artwork where A saw the wall, and B's render where it did not.
  const warped = await registeredPixels(Buffer.from(inputs.image_url.split(",")[1], "base64"), 256, 256, true);
  const render = await registeredPixels(blobs.get("render")!, 256, 256);
  for (const p of [40 * 256 + 40, 128 * 256 + 128, 128 * 256 + 220]) expect(Math.abs(warped[p * 4]! - 200) + Math.abs(warped[p * 4 + 2]! - 40)).toBeLessThan(20);
  expect([...warped.subarray((128 * 256 + 250) * 4, (128 * 256 + 251) * 4)]).toEqual([...render.subarray((128 * 256 + 250) * 4, (128 * 256 + 251) * 4)]);
  ready(); await processNextAssetJob(db, "illustration");
  const asset = store("illustration_assets").get("world:illustration_run1")!;
  expect(asset.keyframe).toMatchObject({ stage: "chain", gate: "passed", chosen: 0, sky_pinned: true, chain_from: { view_id: "front", illustration_id: "illustration_prev" } });
  expect(asset.keyframe.chain_from.angle).toBeCloseTo(4.9, 0); // atan(1 m / 11.6 m), measured in B's frame
  expect(asset.keyframe.chain_from.hole_share).toBeGreaterThan(0.05); expect(asset.keyframe.chain_from.hole_share).toBeLessThan(0.15);
  expect(asset.keyframe.art).toBeUndefined();
  const stored = await registeredPixels(blobs.get(asset.key)!, 256, 256);
  expect(stored[(5 * 256 + 128) * 4]).toBeGreaterThan(170); // sky pinned to the earlier red
  expect(stored[(128 * 256 + 128) * 4 + 2]).toBeGreaterThan(170); // the painted blue candidate
  // A camera without the root place's offset cannot be lined up: not listed, and refused before any spend.
  store("place_views").get("world:front")!.sources = from.sources.filter(s => s.place_id !== "place");
  const ledger = store("spend_ledger").size;
  expect((await illustrationLibrary("world", "view")).chain_sources).toEqual([]);
  const refused = await submitIllustration("world", "view", { ...keyframeRequest, id: "run2", chain_from: "front" }).catch(e => e);
  expect(refused).toMatchObject({ status: 409 }); expect(refused.message).toMatch(/lined up/);
  expect(store("spend_ledger").size).toBe(ledger); expect(store("illustration_jobs").has("world:run2")).toBe(false);
});
it("extends the work lease when the keyframe gate starts, so a slow gate is never reclaimed as an outage", async () => {
  const { state, ready } = await enableKeyframes();
  await submitIllustration("world", "view", keyframeRequest); await processNextAssetJob(db, "illustration");
  ready(); vi.useFakeTimers({ toFake: ["Date"] }); onTestFinished(() => { vi.useRealTimers(); });
  // 200 s of status and storage reads after the claim, then a 200 s gate: past the claim's 360 s lease.
  const impl = provider.getMockImplementation()!, measured = state.gate;
  provider.mockImplementation(async (url: string, init?: RequestInit) => { if (url.includes("/requests/")) vi.setSystemTime(Date.now() + 200_000); return impl(url, init); });
  let reclaimed: boolean | undefined;
  state.gate = async () => { vi.setSystemTime(Date.now() + 200_000); reclaimed = await processNextAssetJob(db, "illustration"); return measured(); };
  await processNextAssetJob(db, "illustration");
  expect(reclaimed).toBe(false);
  expect(illustrationJob()).toMatchObject({ status: "ready", keyframe_gate: { status: "measured" } });
  expect(store("illustration_assets").get("world:illustration_run1")!.keyframe).toMatchObject({ gate: "passed", chosen: 0 });
});
