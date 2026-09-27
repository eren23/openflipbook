// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, Document>>(), owner: true, tail: Promise.resolve(), fail: "" }));
const store = (name: string) => { if (!memory.rows.has(name)) memory.rows.set(name, new Map()); return memory.rows.get(name)!; };
function collection(name: string) {
  const matches = (row: Document, query: Document) => Object.entries(query).every(([k, v]) => v && typeof v === "object" && "$in" in v ? v.$in.includes(row[k]) : v && typeof v === "object" && "$gt" in v ? row[k] > v.$gt : row[k] === v);
  const find = (query: Document) => [...store(name).values()].filter(row => matches(row, query));
  const update = (row: Document, change: Document) => { Object.assign(row, change.$set); for (const [k, v] of Object.entries(change.$inc ?? {})) row[k] = (row[k] ?? 0) + Number(v); };
  return {
    findOne: async (q: Document) => structuredClone(find(q)[0] ?? null),
    find: (q: Document) => { const c = { sort: () => c, limit: () => c, toArray: async () => structuredClone(find(q)) }; return c; },
    insertOne: async (row: Document) => { if (memory.fail === name) throw new Error("write failure"); if (store(name).has(row._id)) throw new Error("duplicate"); store(name).set(row._id, structuredClone(row)); },
    replaceOne: async (_q: Document, row: Document) => { store(name).set(row._id, structuredClone(row)); return { matchedCount: 1 }; },
    updateOne: async (q: Document, change: Document, options: Document = {}) => {
      let row = find(q)[0]; if (!row && options.upsert) { row = { _id: q._id }; store(name).set(row._id, row); } if (row) update(row, change);
    },
    updateMany: async (q: Document, change: Document) => { for (const row of find(q)) update(row, change); },
  };
}
vi.mock("./db", () => ({ getDb: async () => ({ collection }), withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>) => {
  const previous = memory.tail; let release!: () => void; memory.tail = new Promise<void>(resolve => { release = resolve; }); await previous;
  const before = structuredClone(memory.rows);
  try { return await run({ collection } as unknown as Db, {} as ClientSession); } catch (e) { memory.rows = before; throw e; } finally { release(); }
} }));
vi.mock("./creator", async original => ({ ...(await original<object>()), requireCreator: async () => { if (!memory.owner) throw Object.assign(new Error("Not owner"), { status: 403 }); return { collection }; } }));
vi.mock("./session-owner", () => ({ getExistingOwnerToken: async () => "owner-token" }));
vi.mock("./place-scene-enabled", () => ({ placeScenesEnabled: () => true }));
import { adjacentBuildCapabilities, generateAdjacentPlace } from "./adjacent-place-build";
import { applyPlaceScene, createPlaceWorld, previewAdjacentPlace, previewPlaceScene, readPlaceScene } from "./place-scene-server";
import { cancelPlaceBuild, queuePlaceBuild } from "./place-build-server";
import { emptyPlaceScene, newComponent } from "./place-scene";
import { GET, POST } from "@/app/api/world/[sessionId]/places/[geoId]/connections/route";
const provider = vi.fn(), quote = { enabled: true, model: "fixture-planner", reservation: 0.2, connection_context_version: 1 };
beforeEach(() => {
  memory.rows.clear(); memory.owner = true; memory.tail = Promise.resolve(); memory.fail = "";
  vi.stubEnv("MONGODB_URI", "mongodb://test"); vi.stubEnv("MONGODB_DB", "test"); vi.stubEnv("MODAL_API_URL", "https://backend.test");
  vi.stubEnv("MAX_SESSION_SPEND", "0"); vi.stubEnv("MAX_DAILY_SPEND", "0"); vi.stubEnv("PLACE_BUILD_DAILY_CAP_USD", "1");
  provider.mockReset(); provider.mockImplementation(async () => Response.json(quote)); vi.stubGlobal("fetch", provider);
  store("generation_workers").set("worker", { _id: "worker", kind: "place-layout", layout_connections: true, last_seen: new Date() });
  store("place_build_jobs");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function setup() {
  const root = await createPlaceWorld({ request_id: crypto.randomUUID(), definition: { ...emptyPlaceScene(), objects: [newComponent("building", 20, 20)] } });
  const p = await previewAdjacentPlace(root.session_id, root.place_id, { side: "east", width: 3, source_revision: 1, definition: { ...emptyPlaceScene(), label: "Canal workshops" } });
  const input = { place_id: p.place_id, proposal_id: p.proposal.id, prompt: "Two workshops and a public canal path", confirmed: true, reservation: 0.2, model: quote.model };
  return { ...root, p, input, run: (body = input) => generateAdjacentPlace(root.session_id, root.place_id, body) };
}
it("commits one adjoining area, link and scheduled reservation, preserving the source and frozen opening", async () => {
  const { run, session_id: sid, place_id: pid, scene, p } = await setup();
  const result = await run(); expect(result).toMatchObject({ place_id: p.place_id, job: { status: "scheduled", base_revision: 1 } });
  expect((await readPlaceScene(sid, pid)).scene).toEqual(scene);
  expect(store("place_connections").size).toBe(1); expect(store("place_scenes").size).toBe(2); expect(store("place_scene_versions").size).toBe(2);
  const job = [...store("place_build_jobs").values()][0]!;
  expect(job.connection_input).toEqual({ version: 1, place_id: p.place_id, connections: [p.proposal.connection] });
  expect(job.expansion).toEqual({ source_place_id: pid, proposal_id: p.proposal.id });
  expect(job.input_sha256).toMatch(/^[a-f0-9]{64}$/); expect(job.connections_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect([...store("spend_ledger").values()].map(r => r.total)).toEqual([0.2, 0.2, 0.2]);
  expect(provider.mock.calls.every(([url]) => url.endsWith("/capabilities"))).toBe(true);
});
it("concurrent lost-response retries reserve once, and replay works offline without reactivating a cancelled job", async () => {
  const { run, session_id: sid, p } = await setup();
  const [a, b] = await Promise.all([run(), run()]); expect(a).toEqual(b); expect(store("place_build_jobs").size).toBe(1);
  await cancelPlaceBuild(sid, p.place_id, a.job.id); const before = structuredClone(memory.rows);
  provider.mockRejectedValue(new Error("offline")); expect((await run()).job.status).toBe("cancelled"); expect(memory.rows).toEqual(before);
  expect([...store("spend_ledger").values()].every(r => r.total === 0)).toBe(true);
});
it.each(["place_connections", "place_build_jobs"])("rolls back the entire expansion on %s write failure", async name => {
  const { run } = await setup(); memory.fail = name; const before = structuredClone(memory.rows);
  await expect(run()).rejects.toThrow("write failure"); expect(memory.rows).toEqual(before);
  memory.fail = ""; await expect(run()).resolves.toMatchObject({ job: { status: "scheduled" } });
});
it("rolls back geometry and the first ledger when the session budget rejects the reservation", async () => {
  const { run } = await setup(); vi.stubEnv("MAX_SESSION_SPEND", "0.1"); const before = structuredClone(memory.rows);
  await expect(run()).rejects.toMatchObject({ status: 429 }); expect(memory.rows).toEqual(before);
});
it("shares the budget atomically with ordinary queued builds", async () => {
  const { run, session_id: sid, place_id: pid } = await setup(); vi.stubEnv("MAX_SESSION_SPEND", "0.3");
  const results = await Promise.allSettled([run(), queuePlaceBuild(sid, pid, { id: "ordinary", prompt: "A workshop", confirmed: true, base_revision: 1, model: quote.model, reservation: 0.2 })]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 429 } }); expect(store("place_build_jobs").size).toBe(1);
  expect([...store("spend_ledger").values()].map(r => r.total)).toEqual([0.2, 0.2, 0.2]);
});
it("rejects stale proposals, manual-applied proposals and mismatched source bindings without a reservation", async () => {
  const { run, session_id: sid, place_id: pid, scene, p, input } = await setup();
  await expect(generateAdjacentPlace(sid, "another_source", input)).rejects.toMatchObject({ status: 409 });
  const changed = await previewPlaceScene(sid, pid, { base_revision: 1, definition: { ...scene.definition, label: "Renamed centre" } });
  await applyPlaceScene(sid, pid, changed.proposal.id); const before = structuredClone(memory.rows);
  await expect(run()).rejects.toMatchObject({ status: 409 }); expect(memory.rows).toEqual(before);
  const fresh = await previewAdjacentPlace(sid, pid, { side: "east", width: 3, source_revision: 2, definition: p.proposal.definition });
  await applyPlaceScene(sid, fresh.place_id, fresh.proposal.id);
  await expect(run({ ...input, place_id: fresh.place_id, proposal_id: fresh.proposal.id })).rejects.toMatchObject({ status: 409 });
  expect(store("place_build_jobs").size).toBe(0);
});
it("does not spend before ownership, consent or updated connected-worker checks", async () => {
  const { run, input, session_id: sid, place_id: pid } = await setup();
  memory.owner = false; await expect(run()).rejects.toMatchObject({ status: 403 }); await expect(adjacentBuildCapabilities(sid, pid)).rejects.toMatchObject({ status: 403 });
  memory.owner = true; await expect(run({ ...input, confirmed: false })).rejects.toMatchObject({ status: 400 }); expect(provider).not.toHaveBeenCalled();
  delete store("generation_workers").get("worker")!.layout_connections;
  const before = structuredClone(memory.rows); await expect(run()).rejects.toMatchObject({ status: 503 }); expect(memory.rows).toEqual(before);
  expect((await adjacentBuildCapabilities(sid, pid)).capabilities.enabled).toBe(false);
});
it("binds retries to the original description, quote and source, even after successful creation", async () => {
  const { run, input, session_id: sid } = await setup(); await run(); const before = structuredClone(memory.rows);
  for (const patch of [{ prompt: "Another neighborhood" }, { reservation: 0.3 }, { model: "other" }]) await expect(run({ ...input, ...patch })).rejects.toMatchObject({ status: 409 });
  await expect(generateAdjacentPlace(sid, "another_source", input)).rejects.toMatchObject({ status: 409 }); expect(memory.rows).toEqual(before);
});
it("reports unavailable or malformed quotes and rejects quote changes before creating an area", async () => {
  const { run, session_id: sid, place_id: pid } = await setup(); const before = structuredClone(memory.rows);
  provider.mockRejectedValue(new Error("offline")); expect((await adjacentBuildCapabilities(sid, pid)).capabilities.enabled).toBe(false);
  await expect(run()).rejects.toMatchObject({ status: 503 });
  provider.mockImplementation(async () => Response.json({ ...quote, reservation: 0 })); expect((await adjacentBuildCapabilities(sid, pid)).capabilities.enabled).toBe(false);
  provider.mockImplementation(async () => Response.json({ ...quote, reservation: 0.3 })); await expect(run()).rejects.toMatchObject({ status: 409 }); expect(memory.rows).toEqual(before);
});
it("keeps capability reads free and enforces route origin, bounded JSON and explicit actions", async () => {
  const { session_id: sid, place_id: pid, input } = await setup(), params = { params: Promise.resolve({ sessionId: sid, geoId: pid }) };
  const url = `http://localhost/api/world/${sid}/places/${pid}/connections`;
  expect((await GET(new Request(`${url}?generation=1`), params)).status).toBe(200); expect(store("place_build_jobs").size).toBe(0);
  const request = (body: unknown, headers = {}) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  expect((await POST(request({ ...input, action: "generate" }, { origin: "https://foreign.test" }), params)).status).toBe(403);
  for (const body of [null, [], { action: "unknown" }]) expect((await POST(request(body), params)).status).toBe(400);
  expect((await POST(request({ padding: "x".repeat(150_001) }), params)).status).toBe(413);
  expect((await POST(request({ ...input, action: "generate" }), params)).status).toBe(200);
});
