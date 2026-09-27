/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ token: "owner" as string | null, owned: true, nodes: true, scene: false, rows: [] as any[], docs: new Map<string, any>(), places: [{ id: "p1", label: "Market" }] as any[], pipeline: [] as any[], updates: [] as any[], fail: false }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => state.token ? { value: state.token } : undefined }) }));
vi.mock("./world-map", () => ({ getWorldMap: async () => ({ entities: state.places }) }));
vi.mock("./db", () => ({ getDb: async () => {
  if (state.fail) throw new Error("internal connection secret");
  return { collection: (name: string) => ({
    findOne: async (q: any) => name === "session_owners" ? state.owned && q.owner_token === "owner" ? { _id: q._id } : null : name === "nodes" ? state.nodes ? {} : null : name === "place_scenes" ? state.scene && (!q.place_id || q.place_id === "p1") ? {place_id:"p1"} : null : state.docs.get(q._id) ?? null,
    aggregate: (pipeline: any[]) => { state.pipeline = pipeline; return { toArray: async () => state.rows }; },
    updateOne: async (...args: any[]) => { state.updates.push(args); return {}; },
    find: () => ({ sort: () => ({ toArray: async () => [...state.docs.values()] }) }),
    insertOne: async (doc: any) => { if (state.docs.has(doc._id)) throw Object.assign(new Error("dup"), { code: 11000 }); state.docs.set(doc._id, doc); },
    replaceOne: async (q: any, doc: any) => { if (state.docs.get(q._id)?.revision !== q.revision) return { matchedCount: 0 }; state.docs.set(q._id, doc); return { matchedCount: 1 }; },
  }) };
} }));
import { checkCreatorWrite, creatorRoute, listCreatorWorlds, readCreatorNotes, requireCreator, saveCreatorNote, updateCreatorWorld } from "./creator";
import { GET as listGET } from "@/app/api/creator/worlds/route";
import { GET as ownerGET, PATCH } from "@/app/api/creator/worlds/[sessionId]/route";
import { GET as notesGET, PUT } from "@/app/api/creator/worlds/[sessionId]/notes/route";
const params = { params: Promise.resolve({ sessionId: "world" }) };
beforeEach(() => {
  vi.stubEnv("MONGODB_URI", "mongodb://test"); vi.stubEnv("MONGODB_DB", "test"); vi.stubEnv("R2_PUBLIC_BASE_URL", "https://images.test/");
  state.token = "owner"; state.owned = true; state.nodes = true; state.scene = false; state.docs.clear(); state.places = [{ id: "p1", label: "Market" }]; state.rows = []; state.updates = []; state.fail = false;
});
afterEach(() => vi.unstubAllEnvs());
describe("private creator boundary", () => {
  it("does not claim anonymous, foreign or unowned sessions", async () => {
    for (const token of [null, "stranger"]) { state.token = token; await expect(requireCreator("world")).rejects.toMatchObject({ status: 403 }); }
    state.token = "owner"; state.owned = false; await expect(requireCreator("world")).rejects.toMatchObject({ status: 403 });
    expect(state.updates).toEqual([]); expect(state.docs.size).toBe(0);
  });
  it("fails closed without storage and validates IDs", async () => {
    await expect(requireCreator("../world")).rejects.toMatchObject({ status: 400 });
    vi.stubEnv("MONGODB_URI", ""); await expect(requireCreator("world")).rejects.toMatchObject({ status: 503 });
  });
  it("marks successful and failed responses private and redacts internal errors", async () => {
    state.fail = true; const res = await creatorRoute(() => requireCreator("world"));
    expect(res.status).toBe(503); expect(res.headers.get("cache-control")).toBe("private, no-store"); expect(res.headers.get("vary")).toBe("Cookie"); expect(await res.text()).not.toContain("secret");
    state.fail = false; expect((await ownerGET(new Request("http://local"), params)).status).toBe(200);
  });
  it("checks origin and JSON content type", () => {
    expect(() => checkCreatorWrite({ url: "http://local", headers: new Headers({ origin: "http://evil", "content-type": "application/json" }) } as Request)).toThrow("origin");
    expect(() => checkCreatorWrite(new Request("http://local"))).toThrow("JSON");
    expect(() => checkCreatorWrite(new Request("http://local", { headers: { origin: "http://local", "content-type": "application/json" } }))).not.toThrow();
    expect(() => checkCreatorWrite({ url: "http://localhost:3002", headers: new Headers({ host: "127.0.0.1:3002", origin: "http://127.0.0.1:3002", "content-type": "application/json" }) } as Request)).not.toThrow();
    expect(() => checkCreatorWrite({ url: "http://localhost:3002", headers: new Headers({ host: "127.0.0.1:3002", origin: "http://evil", "content-type": "application/json" }) } as Request)).toThrow("origin");
  });
});
describe("library", () => {
  it("retains source-free worlds and validates place resume targets", async () => {
    state.nodes = false; state.scene = true;
    state.rows = [{ _id: "world", title: "Workshop", node_count: 0, place_count: 1, resume_node_id: null, resume_place_id: "p1", last_opened_at: new Date(0), pinned: false, archived: false }];
    expect((await listCreatorWorlds(new URL("http://local"))).worlds[0]).toMatchObject({ image_url: null, node_count: 0, place_count: 1, resume_node_id: null, resume_place_id: "p1" });
    expect(state.pipeline).toContainEqual({ $unwind: { path: "$content", preserveNullAndEmptyArrays: true } });
    await updateCreatorWorld("world", { title: "Renamed", pinned: true });
    await updateCreatorWorld("world", { resume_place_id: "p1" });
    expect(state.updates[1][1].$set).toMatchObject({ resume_place_id: "p1", resume_node_id: null });
    await expect(updateCreatorWorld("world", { resume_place_id: "foreign" })).rejects.toMatchObject({ status: 404 });
    await expect(updateCreatorWorld("world", { resume_place_id: "p1", resume_node_id: "n1" })).rejects.toMatchObject({ status: 400 });
  });
  it("returns an empty anonymous library without touching the DB", async () => {
    state.token = null; state.fail = true;
    expect(await listCreatorWorlds(new URL("http://local"))).toEqual({ worlds: [], next_cursor: null });
  });
  it("projects no secrets and requests only owner-scoped, filtered, paged results", async () => {
    state.rows = Array.from({ length: 21 }, (_, i) => ({ _id: `s${i}`, title: "", image_key: "map.jpg", node_count: 2, pinned: false, archived: true, last_opened_at: new Date(0), resume_node_id: "n1", owner_token: "secret" }));
    const res = await listGET(new Request("http://local/api/creator/worlds?q=a.*&archived=true&cursor=20"));
    const data = await res.json(); expect(data.worlds).toHaveLength(20); expect(data.next_cursor).toBe("40");
    expect(data.worlds[0].image_url).toBe("https://images.test/map.jpg"); expect(JSON.stringify(data)).not.toContain("secret");
    expect(state.pipeline[0]).toEqual({ $match: { owner_token: "owner" } });
    expect(state.pipeline).toContainEqual({ $match: { archived: true, title: { $regex: "a\\.\\*", $options: "i" } } });
    expect(state.pipeline).toContainEqual({ $sort: { pinned: -1, last_opened_at: -1, _id: 1 } });
    vi.stubEnv("R2_PUBLIC_BASE_URL", ""); expect((await listCreatorWorlds(new URL("http://local"))).worlds[0]?.image_url).toBeNull();
  });
  it("rejects invalid pagination and foreign resume targets", async () => {
    await expect(listCreatorWorlds(new URL("http://local?cursor=-1"))).rejects.toMatchObject({ status: 400 });
    await expect(updateCreatorWorld("world", {})).rejects.toMatchObject({ status: 400 });
    state.nodes = false; await expect(updateCreatorWorld("world", { resume_node_id: "foreign" })).rejects.toMatchObject({ status: 404 });
  });
  it("updates title and visit metadata without modifying public nodes", async () => {
    await updateCreatorWorld("world", { title: "Port", pinned: true });
    expect(state.updates[0][1]).toEqual({ $set: { title: "Port", pinned: true } });
    const res = await PATCH(new Request("http://local", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ resume_node_id: "n1" }) }), params);
    expect(res.status).toBe(200); expect(state.updates[1][1].$set.last_opened_at).toBeInstanceOf(Date);
  });
});
describe("private notes", () => {
  it("creates and updates notes with revision-based conflict protection", async () => {
    const saved = await saveCreatorNote("world", { place_id: null, text: "Private world lore", revision: 0 }); expect(saved.note.revision).toBe(1);
    await expect(saveCreatorNote("world", { place_id: null, text: "stale", revision: 0 })).rejects.toMatchObject({ status: 409 });
    await saveCreatorNote("world", { place_id: null, text: "updated", revision: 1 });
    await expect(saveCreatorNote("world", { place_id: null, text: "stale", revision: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await readCreatorNotes("world")).notes[0]?.text).toBe("updated");
  });
  it("retains notes across place renames and removals", async () => {
    await saveCreatorNote("world", { place_id: "p1", text: "Private place lore", revision: 0 });
    state.places = [{ id: "p1", label: "Renamed market" }]; expect((await readCreatorNotes("world")).notes[0]?.label).toBe("Renamed market");
    state.places = []; expect((await readCreatorNotes("world")).notes[0]).toMatchObject({ label: "Market", missing_place: true });
    expect((await saveCreatorNote("world", { place_id: "p1", text: "Still editable", revision: 1 })).note.text).toBe("Still editable");
    await expect(saveCreatorNote("world", { place_id: "missing", text: "", revision: 0 })).rejects.toMatchObject({ status: 404 });
  });
  it("validates route bodies and denies note reads/writes to strangers", async () => {
    expect((await PUT(new Request("http://local", { method: "PUT", headers: { "content-type": "application/json" }, body: "{" }), params)).status).toBe(400);
    state.token = "stranger";
    expect((await notesGET(new Request("http://local"), params)).status).toBe(403);
    expect((await PUT(new Request("http://local", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ place_id: null, text: "bad", revision: 0 }) }), params)).status).toBe(403);
    expect(state.docs.size).toBe(0);
  });
});
