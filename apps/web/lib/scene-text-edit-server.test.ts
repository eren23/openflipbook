import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, Document>>(), owner: true, tail: Promise.resolve(), failFinalization: false }));
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
      if (memory.failFinalization && change.$set?.status === "ready") throw new Error("Storage unavailable after saved provider receipt");
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
vi.mock("./place-scene-server", () => ({ sceneKey: (sid: string, pid: string) => `${sid}:${pid}`, previewPlaceScene: vi.fn(async (_sid, _pid, input, _adj, _generation, origin) => ({ proposal: { id: origin.id, definition: input.definition } })), applyPlaceScene: vi.fn(async () => ({ scene: { revision: 2 } })) }));
vi.mock("./place-scene-enabled", () => ({ placeScenesEnabled: () => true }));
import { emptyPlaceScene, newComponent, parsePlaceScene } from "./place-scene";
import { sceneEditAction, queueSceneEdit, sceneEditLibrary, processNextSceneEdit, sceneEditHash, type SceneEditDoc } from "./scene-text-edit-server";
import { previewPlaceScene, applyPlaceScene } from "./place-scene-server";
const db = { collection } as unknown as Db;
const provider = vi.fn(), input = { action: "plan", id: "job1", prompt: "Paint the saved workshop teal", confirmed: true, reservation: 0.2, model: "test-model", base_revision: 1, selected_object_ids: ["inn"] };
const responseEdits = { version: 1, edits: [{ op: "patch", target: "inn", changes: { color: "#123456" } }] };
const planCalls = () => provider.mock.calls.filter(([url]) => url.endsWith("/plan"));
const currentJob = () => store("scene_edit_jobs").get("world:place:job1")! as SceneEditDoc;
const ledgerTotal = () => [...store("spend_ledger").values()].map(d => d.total);
beforeEach(() => {
  memory.rows.clear(); memory.owner = true; memory.tail = Promise.resolve(); memory.failFinalization = false; provider.mockReset(); vi.clearAllMocks(); vi.stubGlobal("fetch", provider);
  vi.stubEnv("MODAL_API_URL", "https://backend.test"); vi.stubEnv("SCENE_EDIT_DAILY_CAP_USD", "1"); vi.stubEnv("MAX_DAILY_SPEND", "0"); vi.stubEnv("MAX_SESSION_SPEND", "0");
  const definition = parsePlaceScene({ ...emptyPlaceScene(), objects: [{ ...newComponent("building", 12, 12), id: "inn", entity_id: "inn-entity" }] });
  store("place_scenes").set("world:place", { _id: "world:place", id: "scene", session_id: "world", place_id: "place", revision: 1, definition });
  store("generation_workers").set("worker", { _id: "worker", kind: "place-layout", scene_edits: true, last_seen: new Date() });
  provider.mockImplementation(async (url: string) => Response.json(url.endsWith("capabilities") ? { enabled: true, model: "test-model", reservation: 0.2, contract_version: 1 }
    : { status: "ready", model: "test-model", request_id: "provider-job", raw_text: JSON.stringify(responseEdits), result: responseEdits }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("reserves one durable request, freezes selected geometry and replays a lost acknowledgement offline", async () => {
  const before = structuredClone(store("place_scenes").get("world:place")!.definition);
  const [first, second] = await Promise.all([queueSceneEdit("world", "place", input), queueSceneEdit("world", "place", input)]);
  expect(first).toEqual(second); expect(ledgerTotal()).toEqual([0.2, 0.2, 0.2]); expect(store("scene_edit_jobs").size).toBe(1); expect(planCalls()).toHaveLength(0);
  expect(currentJob().input).toEqual(before); expect(currentJob().input_sha256).toBe(sceneEditHash([before, ["inn"], currentJob().connection_input, []]));
  provider.mockRejectedValue(new Error("offline")); store("place_scenes").get("world:place")!.revision++;
  expect(await queueSceneEdit("world", "place", input)).toEqual(first); expect(ledgerTotal()).toEqual([0.2, 0.2, 0.2]);
  await expect(queueSceneEdit("world", "place", { ...input, prompt: "A different edit" })).rejects.toMatchObject({ status: 409 });
});
it("executes once and reuses canonical result and immutable proposal ID for every preview", async () => {
  await queueSceneEdit("world", "place", input); await Promise.all([processNextSceneEdit(db), processNextSceneEdit(db)]);
  expect(currentJob().status).toBe("ready"); expect(planCalls()).toHaveLength(1); expect(currentJob().provider_response!.raw_text).toBe(JSON.stringify(responseEdits));
  expect(currentJob().result!.objects[0]!.id).toBe("inn"); expect(currentJob().receipt).toMatchObject({ version: 1, request_id: "provider-job", output_sha256: sceneEditHash(currentJob().result), selected_object_ids: ["inn"] });
  provider.mockRejectedValue(new Error("offline"));
  const a = await sceneEditAction("world", "place", { action: "preview", id: "job1" }), b = await sceneEditAction("world", "place", { action: "preview", id: "job1" });
  expect(a).toEqual(b); expect(previewPlaceScene).toHaveBeenCalledWith("world", "place", { base_revision: 1, definition: currentJob().result }, undefined, undefined, { id: currentJob().proposal_id, receipt: currentJob().receipt });
  expect(planCalls()).toHaveLength(1);
  await expect(sceneEditAction("world", "place", { action: "apply", id: "job1" })).rejects.toMatchObject({ status: 409 });
  store("world_edit_proposals").set(currentJob().proposal_id, { _id: currentJob().proposal_id, id: currentJob().proposal_id, session_id: "world", place_id: "place", definition: currentJob().result, edit_source: currentJob().receipt });
  await sceneEditAction("world", "place", { action: "apply", id: "job1" }); expect(applyPlaceScene).toHaveBeenCalledOnce(); expect(planCalls()).toHaveLength(1);
});
it("refreshes stale world review context with one new durable review identity and no model call", async () => {
  await queueSceneEdit("world", "place", input); await processNextSceneEdit(db);
  const original = await sceneEditAction("world", "place", { action: "preview", id: "job1" });
  const request = { action: "refresh-preview", id: "job1", review_id: "review-once" };
  const first = await sceneEditAction("world", "place", request), replay = await sceneEditAction("world", "place", request);
  expect(first).toEqual(replay); expect(first).not.toEqual(original); expect(planCalls()).toHaveLength(1);
  const calls = vi.mocked(previewPlaceScene).mock.calls;
  expect(calls[1]![5]!.id).toEqual(calls[2]![5]!.id); expect(calls[1]![5]!.id).not.toBe(currentJob().proposal_id);
  expect(calls[1]![2].definition).toEqual(currentJob().result);
  await expect(sceneEditAction("world", "place", { ...request, review_id: "" })).rejects.toMatchObject({ status: 400 });
  store("place_scenes").get("world:place")!.definition.objects[0].x++;
  await expect(sceneEditAction("world", "place", { ...request, review_id: "next" })).rejects.toMatchObject({ status: 409 }); expect(planCalls()).toHaveLength(1);
});
it("recovers validation after a storage failure using saved raw text without calling the model again", async () => {
  await queueSceneEdit("world", "place", input); memory.failFinalization = true; await processNextSceneEdit(db);
  expect(currentJob().status).toBe("validating"); expect(currentJob().provider_response!.raw_text).toBe(JSON.stringify(responseEdits)); expect(planCalls()).toHaveLength(1);
  memory.failFinalization = false; provider.mockRejectedValue(new Error("offline")); await processNextSceneEdit(db);
  expect(currentJob().status).toBe("ready"); expect(planCalls()).toHaveLength(1); expect(ledgerTotal()).toEqual([0.2, 0.2, 0.2]);
});
it("preserves ambiguous submissions and never retries expired claims", async () => {
  await queueSceneEdit("world", "place", input); provider.mockRejectedValue(new Error("provider timeout")); await processNextSceneEdit(db);
  expect(currentJob().status).toBe("submission_unknown"); expect(planCalls()).toHaveLength(1);
  expect(await processNextSceneEdit(db)).toBe(false); expect(planCalls()).toHaveLength(1); expect(ledgerTotal()).toEqual([0.2, 0.2, 0.2]);
  currentJob().status = "planning"; currentJob().deadline = new Date(0); await sceneEditLibrary("world", "place");
  expect(currentJob().status).toBe("submission_unknown"); expect(await processNextSceneEdit(db)).toBe(false); expect(planCalls()).toHaveLength(1);
});
it.each(["geometry", "connections", "materials"])("releases stale %s inputs before paid submission", async change => {
  if (change === "materials") store("material_assets").set("world:m1", { _id: "world:m1", id: "m1", session_id: "world", sha256: "a".repeat(64), prompt: "Grey stone", created_at: new Date() });
  await queueSceneEdit("world", "place", input);
  if (change === "geometry") store("place_scenes").get("world:place")!.revision++;
  if (change === "connections") currentJob().connections_sha256 = "b".repeat(64);
  if (change === "materials") store("material_assets").get("world:m1")!.sha256 = "b".repeat(64);
  await processNextSceneEdit(db); expect(currentJob().status).toBe("cancelled"); expect(ledgerTotal()).toEqual([0, 0, 0]); expect(planCalls()).toHaveLength(0);
  await sceneEditAction("world", "place", { action: "cancel", id: "job1" }); expect(ledgerTotal()).toEqual([0, 0, 0]);
});
it("keeps rejected raw output and reservation without a repair call", async () => {
  await queueSceneEdit("world", "place", input);
  const bad = { version: 1, edits: [{ op: "patch", target: "inn", changes: { id: "forged" } }] };
  provider.mockImplementation(async () => Response.json({ status: "ready", model: "test-model", raw_text: JSON.stringify(bad), result: bad }));
  await processNextSceneEdit(db); expect(currentJob().status).toBe("invalid"); expect(currentJob().provider_response!.raw_text).toBe(JSON.stringify(bad));
  await processNextSceneEdit(db); expect(planCalls()).toHaveLength(1); expect(ledgerTotal()).toEqual([0.2, 0.2, 0.2]);
});
it("rejects mismatched raw/result payloads and unquoted material IDs deterministically", async () => {
  await queueSceneEdit("world", "place", input);
  const foreign = { version: 1, edits: [{ op: "patch", target: "inn", changes: { materials: { wall: { asset_id: "foreign", tile_metres: 2, rotation: 0, roughness: 0.8 } } } }] };
  provider.mockImplementation(async () => Response.json({ status: "ready", model: "test-model", raw_text: JSON.stringify(foreign), result: foreign }));
  await processNextSceneEdit(db); expect(currentJob().status).toBe("invalid"); expect(currentJob().error).toContain("outside its saved library");
});
it("rolls back caps atomically and rejects non-owned or unsupported quotes", async () => {
  vi.stubEnv("SCENE_EDIT_DAILY_CAP_USD", "0.2"); await queueSceneEdit("world", "place", input);
  await expect(queueSceneEdit("world", "place", { ...input, id: "job2" })).rejects.toMatchObject({ status: 429 });
  expect(ledgerTotal()).toEqual([0.2, 0.2, 0.2]); expect(store("scene_edit_jobs").size).toBe(1);
  memory.owner = false; await expect(queueSceneEdit("world", "place", input)).rejects.toMatchObject({ status: 403 }); memory.owner = true;
  store("generation_workers").get("worker")!.scene_edits = false;
  await expect(queueSceneEdit("world", "place", { ...input, id: "job3" })).rejects.toMatchObject({ status: 503 }); expect(planCalls()).toHaveLength(0);
});
it("cancels an unsent request exactly once and retains billable ambiguous reservations", async () => {
  await queueSceneEdit("world", "place", input); await sceneEditAction("world", "place", { action: "cancel", id: "job1" }); await sceneEditAction("world", "place", { action: "cancel", id: "job1" });
  expect(ledgerTotal()).toEqual([0, 0, 0]); expect(await processNextSceneEdit(db)).toBe(false);
  await queueSceneEdit("world", "place", { ...input, id: "job2" }); provider.mockRejectedValue(new Error("timeout")); await processNextSceneEdit(db);
  await sceneEditAction("world", "place", { action: "cancel", id: "job2" }); expect(ledgerTotal()).toEqual([0.2, 0.2, 0.2]);
});
