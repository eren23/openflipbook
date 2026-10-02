import { describe, expect, it, vi } from "vitest";

// In-memory Mongo stand-in with PER-COLLECTION stores — forkSession touches
// nodes + world_map + world_state, and the test must prove all three copy
// (the silent-corruption class: one missed collection = a fork that loses
// its geo state).
const mongo = vi.hoisted(() => {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();
  const session = { fixture: "fork transaction" };
  const fault: { collection: string | null } = { collection: null };
  let active = false;
  const check = (options?: { session?: unknown }) => { if (active && options?.session !== session) throw new Error("Copy escaped its transaction"); };
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const collection = (name: string) => ({
    find(filter: { session_id?: string }, options?: { session?: unknown }) {
      check(options);
      const rows = [...store(name).values()].filter(
        (d) => !filter.session_id || d.session_id === filter.session_id
      );
      return {
        sort() {
          return this;
        },
        async toArray() {
          return rows;
        },
      };
    },
    async findOne(filter: { _id: string }, options?: { session?: unknown }) {
      check(options);
      return store(name).get(filter._id) ?? null;
    },
    async insertOne(doc: { _id: string }, options?: { session?: unknown }) {
      check(options); if (fault.collection === name) throw new Error("Injected copy failure");
      if (store(name).has(doc._id)) throw new Error("dup");
      store(name).set(doc._id, doc);
    },
    async insertMany(docs: { _id: string }[], options?: { session?: unknown }) {
      check(options); if (fault.collection === name) throw new Error("Injected copy failure");
      for (const d of docs) {
        if (store(name).has(d._id)) throw new Error("dup");
        store(name).set(d._id, d);
      }
    },
  });
  const transaction = vi.fn(async (run: (db: unknown, session: unknown) => Promise<unknown>) => {
    const before = structuredClone(stores); active = true;
    try { return await run({ collection }, session); }
    catch (e) { stores.clear(); for (const [key, value] of before) stores.set(key, value); throw e; }
    finally { active = false; }
  });
  return { stores, store, collection, transaction, fault };
});

vi.mock("./db", () => ({
  getDb: async () => ({ collection: mongo.collection }),
  withDbTransaction: mongo.transaction,
}));
vi.mock("./session-owner", () => ({ getExistingOwnerToken: vi.fn(async () => "token") }));
import { getExistingOwnerToken } from "./session-owner";

import { forkSession } from "./fork";
import { viewHash } from "./place-view-store";
import { motionStudyFixture } from "@/tests/fixtures/motion-study";

const SRC = "session_src";

function seedMotion(viewId = "view") {
  if (!mongo.store("place_views").has(`${SRC}:${viewId}`)) mongo.store("place_views").set(`${SRC}:${viewId}`, { _id: `${SRC}:${viewId}`, id: viewId, session_id: SRC });
  const study = { ...motionStudyFixture(), _id: `${SRC}:study`, session_id: SRC, view_id: viewId };
  const asset = { _id: `${SRC}:clip`, id: "clip", session_id: SRC, study_id: study.id, study_sha256: viewHash(study),
    preparation_sha256: study.preparation_sha256, request_id: "existing-provider-receipt",
    original: { key: "immutable/original.mp4", sha256: "original", bytes: 200 }, silent: { key: "immutable/silent.mp4", sha256: "silent", bytes: 100 },
    comparison: { sha256: "criteria", plan: {} } };
  const review = { _id: `${SRC}:review`, id: "review", session_id: SRC, study_id: study.id, asset_id: "clip",
    video_sha256: "silent", comparison_sha256: "criteria", review: { notes: "Selected review" }, outcome: { status: "pass" } };
  mongo.store("motion_studies").set(study._id, study);
  mongo.store("motion_assets").set(asset._id, asset);
  mongo.store("motion_reviews").set(review._id, review);
  mongo.store("motion_reviews").set(`${SRC}:failed-review`, { ...review, _id: `${SRC}:failed-review`, id: "failed-review", outcome: { status: "fail" }, review: { notes: "Retain failure evidence" } });
  mongo.store("motion_selections").set(`${SRC}:study`, { _id: `${SRC}:study`, asset_id: "clip", review_id: "review" });
  mongo.store("motion_jobs").set(`${SRC}:pending`, { _id: `${SRC}:pending`, session_id: SRC, status: "scheduled", reservation: 1 });
  mongo.store("spend_ledger").set(SRC, { _id: SRC, total: 1 });
  return { study, asset, review };
}

function seed() {
  vi.mocked(getExistingOwnerToken).mockReset(); vi.mocked(getExistingOwnerToken).mockResolvedValue("token");
  mongo.transaction.mockClear(); mongo.fault.collection = null;
  mongo.stores.clear();
  mongo.store("session_owners").set(SRC, { _id: SRC, owner_token: "token" });
  const nodes = mongo.store("nodes");
  nodes.set("root1", {
    _id: "root1",
    session_id: SRC,
    parent_id: null,
    page_title: "The Map",
    image_key: "k/root.jpg",
    scene_view: null,
    created_at: new Date("2026-01-01"),
  });
  nodes.set("child1", {
    _id: "child1",
    session_id: SRC,
    parent_id: "root1",
    page_title: "The Tower",
    image_key: "k/tower.jpg",
    scene_view: { node_id: "child1", level: "building", observer: null },
    created_at: new Date("2026-01-02"),
  });
  nodes.set("other", {
    _id: "other",
    session_id: "session_unrelated",
    parent_id: null,
    page_title: "Elsewhere",
    image_key: "k/x.jpg",
    scene_view: null,
    created_at: new Date("2026-01-01"),
  });
  mongo.store("world_map").set(SRC, {
    _id: SRC,
    entities: [{ id: "geo_tower", pos: { x: 1, y: 2 } }],
    bounds: { x: 0, y: 0, w: 100, h: 60 },
  });
  mongo.store("world_state").set(SRC, {
    _id: SRC,
    entities: [
      {
        id: "tower",
        name: "The Tower",
        first_seen_node_id: "root1",
        last_seen_node_id: "child1",
        appears_on_node_ids: ["root1", "child1", "long-gone"],
        appearance_bboxes: { child1: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 } },
        appearance_borders: { child1: [[0.1, 0.1]] },
      },
    ],
  });
}
it("retains private camera captures and immutable files on an owner fork only", async () => {
  seed();
  const view = { _id: `${SRC}:view`, session_id: SRC, id: "view", root_place_id: "place", camera: { world_matrix: [1] }, sources: [{ place_id: "place", revision: 2, definition_sha256: "geometry" }], files: { render: { key: "immutable.png", sha256: "pixels" } } };
  mongo.store("place_views").set(view._id, view);
  const illustration = { _id: `${SRC}:illustration_one`, id: "illustration_one", session_id: SRC, key: "immutable/view.jpg", sha256: "artwork", view_dependency: { view_id: "view", input_sha256: "source" } };
  mongo.store("illustration_assets").set(illustration._id, illustration);
  mongo.store("illustration_jobs").set(`${SRC}:pending`, { _id: `${SRC}:pending`, session_id: SRC, status: "scheduled" });
  // Walk checkpoints serve only walk videos, which forks do not copy.
  mongo.store("place_views").set(`${SRC}:checkpoint`, { ...view, _id: `${SRC}:checkpoint`, id: "checkpoint", walk_checkpoint: true });
  const fork = await forkSession(SRC, "root1");
  expect(mongo.store("place_views").get(`${fork!.session_id}:view`)).toEqual({ ...view, _id: `${fork!.session_id}:view`, session_id: fork!.session_id });
  expect(mongo.store("place_views").has(`${fork!.session_id}:checkpoint`)).toBe(false);
  expect(mongo.store("illustration_assets").get(`${fork!.session_id}:illustration_one`)).toEqual({ ...illustration, _id: `${fork!.session_id}:illustration_one`, session_id: fork!.session_id });
  expect([...mongo.store("illustration_jobs").values()].some(j => j.session_id === fork!.session_id)).toBe(false);
  vi.mocked(getExistingOwnerToken).mockResolvedValueOnce("viewer");
  const viewerFork = await forkSession(SRC, "root1");
  expect([...mongo.store("place_views").values()].some(v => v.session_id === viewerFork!.session_id)).toBe(false);
  expect([...mongo.store("illustration_assets").values()].some(v => v.session_id === viewerFork!.session_id)).toBe(false);
});
it("does not silently treat a private-capture permission outage as a public fork", async () => {
  seed(); mongo.store("place_views").set("private", { _id: "private", session_id: SRC });
  vi.mocked(getExistingOwnerToken).mockRejectedValueOnce(new Error("Database offline"));
  const before = mongo.store("nodes").size;
  await expect(forkSession(SRC, "root1")).rejects.toThrow("Database offline"); expect(mongo.store("nodes").size).toBe(before);
});
it("forks owned motion evidence with new study bindings but identical immutable files and no jobs", async () => {
  seed(); const source = seedMotion(); const before = structuredClone(source);
  const fork = (await forkSession(SRC, "root1"))!, sid = fork.session_id;
  const study = mongo.store("motion_studies").get(`${sid}:study`)!;
  expect(study).toMatchObject({ session_id: sid, preparation: source.study.preparation, source: source.study.source,
    forked_from: { session_id: SRC, study_id: "study", study_sha256: viewHash(source.study) } });
  expect(mongo.store("motion_assets").get(`${sid}:clip`)).toEqual({ ...source.asset, _id: `${sid}:clip`, session_id: sid,
    study_sha256: viewHash(study), forked_from: { session_id: SRC, asset_id: "clip", study_sha256: source.asset.study_sha256 } });
  expect(mongo.store("motion_reviews").get(`${sid}:review`)).toEqual({ ...source.review, _id: `${sid}:review`, session_id: sid });
  expect(mongo.store("motion_reviews").get(`${sid}:failed-review`)).toMatchObject({ outcome: { status: "fail" }, review: { notes: "Retain failure evidence" } });
  expect(mongo.store("motion_selections").get(`${sid}:study`)).toMatchObject({ asset_id: "clip", review_id: "review" });
  expect([...mongo.store("motion_jobs").values()].filter(j => j.session_id === sid)).toEqual([]);
  expect(mongo.store("spend_ledger").size).toBe(1); expect(source).toEqual(before);
  const again = (await forkSession(sid, null))!;
  const nextStudy = mongo.store("motion_studies").get(`${again.session_id}:study`)!;
  expect(mongo.store("motion_assets").get(`${again.session_id}:clip`)).toMatchObject({ study_sha256: viewHash(nextStudy), silent: source.asset.silent });
});
it("does not expose private motion evidence to a public-world viewer fork", async () => {
  seed(); seedMotion(); vi.mocked(getExistingOwnerToken).mockResolvedValueOnce("viewer");
  const fork = (await forkSession(SRC, "root1"))!;
  for (const name of ["motion_studies", "motion_assets", "motion_reviews", "motion_jobs"]) expect([...mongo.store(name).values()].some(doc => doc.session_id === fork.session_id)).toBe(false);
  expect(mongo.store("motion_selections").has(`${fork.session_id}:study`)).toBe(false);
});
it.each(["camera", "study", "video", "review", "selection"])("rejects a broken motion %s binding atomically", async kind => {
  seed(); const source = seedMotion();
  if (kind === "camera") mongo.store("place_views").clear();
  if (kind === "study") source.asset.study_sha256 = "wrong-study";
  if (kind === "video") source.review.video_sha256 = "different-video";
  if (kind === "review") source.review.asset_id = "other-asset";
  if (kind === "selection") mongo.store("motion_selections").get(`${SRC}:study`)!.review_id = "missing-review";
  const before = structuredClone(mongo.stores);
  await expect(forkSession(SRC, "root1")).rejects.toThrow("fork was not created");
  expect(mongo.stores).toEqual(before);
});

describe("forkSession", () => {
  function richSeed() {
    seed();
    mongo.store("creator_worlds").set(SRC, { _id: SRC, visibility: "private", title: "Private world" });
    for (const collection of ["place_scenes", "place_scene_versions"]) mongo.store(collection).set(`${SRC}:place`, { _id: `${SRC}:place`, session_id: SRC, id: "scene", place_id: "place", revision: 2, source_node_id: "root1", definition: { label: "Courtyard", objects: [] } });
    for (const collection of ["place_connections", "mesh_sources", "mesh_assets", "material_assets", "place_views", "illustration_assets"]) mongo.store(collection).set(`${SRC}:asset`, { _id: `${SRC}:asset`, session_id: SRC, id: "asset", view_dependency: { view_id: "asset" }, key: "immutable" });
    mongo.store("map_artwork_versions").set("child1", { _id: "child1", session_id: SRC, node_id: "child1", scene_source_node_id: "child1", map_root_node_id: "root1", base_map_node_id: "root1" });
    mongo.store("map_artwork_heads").set(`${SRC}:root1`, { _id: `${SRC}:root1`, session_id: SRC, node_id: "child1", map_root_node_id: "root1" });
    mongo.store("map_alignment_drafts").set(`${SRC}:place`,{_id:`${SRC}:place`,session_id:SRC,place_id:"place",map_node_id:"root1",scene_source_node_id:"root1",landmarks:[]});
    seedMotion("asset");
  }
  it.each(["creator_worlds", "nodes", "world_map", "world_state", "place_scenes", "place_scene_versions", "place_connections", "mesh_sources", "mesh_assets", "material_assets", "place_views", "illustration_assets", "motion_studies", "motion_assets", "motion_reviews", "motion_selections", "map_artwork_versions", "map_artwork_heads", "map_alignment_drafts", "session_owners", "fork_receipts"])("rolls back the entire copy on a %s write failure", async collection => {
    richSeed(); const before = structuredClone(mongo.stores); mongo.fault.collection = collection;
    await expect(forkSession(SRC, "root1", "failed-copy")).rejects.toThrow("Injected copy failure");
    expect(mongo.stores).toEqual(before);
    mongo.fault.collection = null;
    const retry = (await forkSession(SRC, "root1", "failed-copy"))!;
    expect(mongo.store("session_owners").get(retry.session_id)).toMatchObject({ owner_token: "token" });
    expect(mongo.store("fork_receipts").size).toBe(1);
    expect(mongo.transaction).toHaveBeenCalledWith(expect.any(Function), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  });
  it("replays the same owned snapshot without re-copying changes or requiring the old source", async () => {
    richSeed(); const fork = (await forkSession(SRC, "root1", "lost-response"))!;
    const child = [...mongo.store("nodes").values()].find(n => n.session_id === fork.session_id && n.parent_id)!;
    child.page_title = "Edited in the copy";
    mongo.store("nodes").delete("root1"); mongo.store("nodes").delete("child1");
    const before = structuredClone(mongo.stores);
    expect(await forkSession(SRC, "root1", "lost-response")).toEqual(fork);
    expect(mongo.stores).toEqual(before);
    await expect(forkSession("another_source", "root1", "lost-response")).rejects.toMatchObject({ status: 409 });
    mongo.store("session_owners").delete(fork.session_id);
    await expect(forkSession(SRC, "root1", "lost-response")).rejects.toMatchObject({ status: 403 });
  });
  it("uses only the committed receipt after a concurrent duplicate-key winner", async () => {
    seed(); const result = await forkSession(SRC, "root1", "concurrent-copy"), before = structuredClone(mongo.stores);
    mongo.transaction.mockRejectedValueOnce(Object.assign(new Error("Concurrent insert"), { code: 11000 }));
    expect(await forkSession(SRC, "root1", "concurrent-copy")).toEqual(result);
    expect(mongo.stores).toEqual(before);
    mongo.transaction.mockRejectedValueOnce(Object.assign(new Error("Unrelated collision"), { code: 11000 }));
    await expect(forkSession(SRC, "root1", "different-copy")).rejects.toThrow("Unrelated collision");
  });
  it("rejects invalid identities and absent browser credentials before starting a transaction", async () => {
    seed(); await expect(forkSession(SRC, null, "../bad")).rejects.toMatchObject({ status: 400 });
    vi.mocked(getExistingOwnerToken).mockResolvedValueOnce(null);
    await expect(forkSession(SRC, null)).rejects.toMatchObject({ status: 409 });
    expect(mongo.transaction).not.toHaveBeenCalled();
  });
  it("rejects an unrelated lineage node and private-source access before publishing anything", async () => {
    richSeed(); const before = structuredClone(mongo.stores);
    await expect(forkSession(SRC, "other")).rejects.toMatchObject({ status: 400 });
    vi.mocked(getExistingOwnerToken).mockResolvedValueOnce("viewer");
    await expect(forkSession(SRC, "root1")).rejects.toMatchObject({ status: 403 });
    expect(mongo.stores).toEqual(before);
  });
  it("forks source-free geometry only for its owner and keeps it private", async () => {
    richSeed(); mongo.store("nodes").delete("root1"); mongo.store("nodes").delete("child1");
    mongo.store("map_artwork_versions").clear(); mongo.store("map_artwork_heads").clear(); mongo.store("map_alignment_drafts").clear();
    mongo.store("creator_worlds").delete(SRC);
    const fork = (await forkSession(SRC, null))!;
    expect(fork).toMatchObject({ nodes: 0, place_id: "place" });
    expect(mongo.store("creator_worlds").get(fork.session_id)).toMatchObject({ visibility: "private", resume_place_id: "place" });
    vi.mocked(getExistingOwnerToken).mockResolvedValueOnce("viewer");
    await expect(forkSession(SRC, null)).rejects.toMatchObject({ status: 403 });
  });
  it("retains concept originals for the owner but excludes them from a viewer fork", async () => {
    seed();
    const source = { _id: `${SRC}:concept`, id: "concept", session_id: SRC, key: "private/input.png", original: { key: "private/original.png" }, origin: { kind: "saved_world_image", node_id: "root1" } };
    mongo.store("mesh_sources").set(source._id, source);
    const asset = { _id: `${SRC}:mesh_one`, id: "mesh_one", session_id: SRC, key: "mesh.glb", image_input: source };
    mongo.store("mesh_assets").set(asset._id, asset);
    const fork = (await forkSession(SRC, "root1"))!;
    const copied = { ...source, _id: `${fork.session_id}:concept`, session_id: fork.session_id };
    expect(mongo.store("mesh_sources").get(copied._id)).toEqual(copied);
    expect(mongo.store("mesh_assets").get(`${fork.session_id}:mesh_one`)!.image_input).toEqual(copied);
    vi.mocked(getExistingOwnerToken).mockResolvedValueOnce("viewer");
    const viewer = (await forkSession(SRC, "root1"))!;
    expect([...mongo.store("mesh_sources").values()].some(s => s.session_id === viewer.session_id)).toBe(false);
    expect(mongo.store("mesh_assets").get(`${viewer.session_id}:mesh_one`)).not.toHaveProperty("image_input");
  });
  it("checks concept privacy before creating any fork nodes", async () => {
    seed(); mongo.store("mesh_sources").set("concept", { _id: "concept", session_id: SRC });
    vi.mocked(getExistingOwnerToken).mockRejectedValueOnce(new Error("Database offline"));
    const count = mongo.store("nodes").size;
    await expect(forkSession(SRC, "root1")).rejects.toThrow("Database offline"); expect(mongo.store("nodes").size).toBe(count);
  });
  it("copies immutable mesh asset bindings without copying billable jobs", async () => {
    seed();
    const asset = {_id:`${SRC}:mesh_one`, id:"mesh_one", session_id:SRC, key:"immutable/model.glb", sha256:"digest", prompt:"A bakery", model:"provider-model"};
    mongo.store("mesh_assets").set(asset._id,asset);
    mongo.store("mesh_jobs").set(`${SRC}:job`,{_id:`${SRC}:job`,session_id:SRC,status:"ready"});
    const fork=(await forkSession(SRC,"root1"))!;
    expect(mongo.store("mesh_assets").get(`${fork.session_id}:mesh_one`)).toEqual({...asset,_id:`${fork.session_id}:mesh_one`,session_id:fork.session_id});
    expect(mongo.store("mesh_jobs").size).toBe(1);
    expect(mongo.store("mesh_assets").get(asset._id)).toEqual(asset);
  });
  it("remaps map artwork history and the active head into the fork", async () => {
    seed();
    mongo.store("map_artwork_versions").set("child1", { _id: "child1", node_id: "child1", session_id: SRC, map_root_node_id: "root1", base_map_node_id: "root1", scene_source_node_id: "child1", scene_id: "scene", place_id: "place", scene_revision: 3 });
    mongo.store("map_artwork_heads").set(`${SRC}:root1`, { _id: `${SRC}:root1`, session_id: SRC, map_root_node_id: "root1", node_id: "child1" });
    const fork = (await forkSession(SRC, "root1"))!;
    const nodes = [...mongo.store("nodes").values()].filter(n => n.session_id === fork.session_id);
    const root = nodes.find(n => n.parent_id === null)!;
    const child = nodes.find(n => n.parent_id === root._id)!;
    expect(mongo.store("map_artwork_heads").get(`${fork.session_id}:${root._id}`)).toMatchObject({ session_id: fork.session_id, node_id: child._id, map_root_node_id: root._id });
    expect(mongo.store("map_artwork_versions").get(child._id as string)).toMatchObject({ node_id: child._id, session_id: fork.session_id, base_map_node_id: root._id, map_root_node_id: root._id, scene_source_node_id: child._id, scene_id: "scene", place_id: "place", scene_revision: 3 });
    expect(mongo.store("map_artwork_heads").get(`${SRC}:root1`)!.node_id).toBe("child1");
  });
  it("copies scene revisions and remaps their source while leaving proposal receipts behind", async () => {
    seed();
    const scene = { id: "scene", session_id: SRC, place_id: "geo_tower", source_node_id: "root1", source_image_key: "immutable.png", revision: 2, definition: { material_pack: "ankh-street-v1", objects: [{ id: "bench", entity_id: "bench_entity", eave_height: 6.2, roof_offset: 2, roof_material: "teal" }] } };
    mongo.store("place_scenes").set(`${SRC}:geo_tower`, { ...scene, _id: `${SRC}:geo_tower` });
    mongo.store("place_scene_versions").set(`${SRC}:geo_tower:2`, { ...scene, _id: `${SRC}:geo_tower:2` });
    mongo.store("world_edit_proposals").set("proposal", { _id: "proposal", session_id: SRC });
    const fork = (await forkSession(SRC, "root1"))!;
    const root = [...mongo.store("nodes").values()].find(n => n.session_id === fork.session_id && n.parent_id === null)!;
    const copied = mongo.store("place_scenes").get(`${fork.session_id}:geo_tower`)!;
    expect(copied).toMatchObject({ ...scene, session_id: fork.session_id, source_node_id: root._id });
    expect(mongo.store("place_scene_versions").get(`${fork.session_id}:geo_tower:2`)).toMatchObject({ source_node_id: root._id });
    expect(mongo.store("world_edit_proposals").size).toBe(1);
  });
  it('remaps transition edge references while retaining source-image identity', async () => {
    seed();
    mongo.store('nodes').get('child1')!.transition_context = {
      version: 1, source_node_id: 'root1', source_image_key: 'k/root.jpg',
      target_point: { x_pct: .8, y_pct: .3 }, target_geo_id: 'geo_tower',
      source_view: { node_id: 'root1', level: 'map' }, destination_view: { node_id: 'child1', level: 'eye' },
    };
    const forked = (await forkSession(SRC, 'child1'))!;
    const rows = [...mongo.store('nodes').values()].filter(n => n.session_id === forked.session_id);
    const parent = rows.find(n => n.parent_id == null)!;
    const child = rows.find(n => n.parent_id != null)!;
    expect(child.transition_context).toMatchObject({ source_node_id: parent._id, source_image_key: 'k/root.jpg', source_view: { node_id: parent._id }, destination_view: { node_id: child._id } });
  });
  it("remaps a curated anchor's node but preserves its original bytes and crop", async () => {
    seed();
    const anchor = { node_id: "root1", image_key: "original-before-edit.png", bbox: { x_pct: .1, y_pct: .2, w_pct: .3, h_pct: .4 } };
    mongo.store("world_map").get(SRC)!.entities = [{ id: "geo_tower", identity_locked: true, identity_anchor: anchor }];
    const forked = (await forkSession(SRC, "root1"))!;
    const root = [...mongo.store("nodes").values()].find(n => n.session_id === forked.session_id && n.parent_id === null)!;
    const geos = mongo.store("world_map").get(forked.session_id)!.entities as Record<string, unknown>[];
    expect(geos[0]).toMatchObject({ id: "geo_tower", identity_locked: true, identity_anchor: { ...anchor, node_id: root._id } });
  });
  it("copies nodes + world_map + world_state under a fresh session, ids reminted", async () => {
    seed();
    const forked = await forkSession(SRC, "child1");
    expect(forked).not.toBeNull();
    const { session_id } = forked!;
    expect(session_id).not.toBe(SRC);

    const newNodes = [...mongo.store("nodes").values()].filter(
      (n) => n.session_id === session_id
    );
    expect(newNodes).toHaveLength(2); // the unrelated session's node stays out
    const newRoot = newNodes.find((n) => n.parent_id === null)!;
    const newChild = newNodes.find((n) => n.parent_id !== null)!;
    // ids reminted, parent chain + scene_view self-reference remapped
    expect(newRoot._id).not.toBe("root1");
    expect(newChild.parent_id).toBe(newRoot._id);
    expect((newChild.scene_view as { node_id: string }).node_id).toBe(
      newChild._id
    );
    // lineage on the root only
    expect(newRoot.forked_from).toEqual({
      session_id: SRC,
      node_id: "child1",
    });
    expect(newChild.forked_from).toBeUndefined();

    // world_map copied under the new _id (the Ankh gotcha), content verbatim
    const map = mongo.store("world_map").get(session_id)!;
    expect((map.entities as { id: string }[])[0]!.id).toBe("geo_tower");

    // world_state entity node-refs remapped in all five places; a dangling
    // pre-fork id stays as-is (never invented, never dropped)
    const st = mongo.store("world_state").get(session_id)!;
    const e = (st.entities as Record<string, unknown>[])[0]!;
    expect(e.first_seen_node_id).toBe(newRoot._id);
    expect(e.last_seen_node_id).toBe(newChild._id);
    expect(e.appears_on_node_ids).toEqual([
      newRoot._id,
      newChild._id,
      "long-gone",
    ]);
    expect(Object.keys(e.appearance_bboxes as object)).toEqual([newChild._id]);
    expect(Object.keys(e.appearance_borders as object)).toEqual([newChild._id]);
  });

  it("leaves the source session byte-identical", async () => {
    seed();
    const before = JSON.stringify([
      mongo.store("nodes").get("root1"),
      mongo.store("nodes").get("child1"),
      mongo.store("world_map").get(SRC),
      mongo.store("world_state").get(SRC),
    ]);
    await forkSession(SRC, "child1");
    const after = JSON.stringify([
      mongo.store("nodes").get("root1"),
      mongo.store("nodes").get("child1"),
      mongo.store("world_map").get(SRC),
      mongo.store("world_state").get(SRC),
    ]);
    expect(after).toBe(before);
  });

  it("returns null for an unknown session (the route 404s)", async () => {
    seed();
    expect(await forkSession("session_nope", null)).toBeNull();
  });

  it("forks sessions that never built a world model (nodes only)", async () => {
    seed();
    mongo.store("world_map").delete(SRC);
    mongo.store("world_state").delete(SRC);
    const forked = await forkSession(SRC, null);
    expect(forked!.nodes).toBe(2);
    expect(mongo.store("world_map").get(forked!.session_id)).toBeUndefined();
  });
});
