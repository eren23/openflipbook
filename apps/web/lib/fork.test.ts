import { describe, expect, it, vi } from "vitest";

// In-memory Mongo stand-in with PER-COLLECTION stores — forkSession touches
// nodes + world_map + world_state, and the test must prove all three copy
// (the silent-corruption class: one missed collection = a fork that loses
// its geo state).
const mongo = vi.hoisted(() => {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const collection = (name: string) => ({
    find(filter: { session_id?: string }) {
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
    async findOne(filter: { _id: string }) {
      return store(name).get(filter._id) ?? null;
    },
    async insertOne(doc: { _id: string }) {
      if (store(name).has(doc._id)) throw new Error("dup");
      store(name).set(doc._id, doc);
    },
    async insertMany(docs: { _id: string }[]) {
      for (const d of docs) {
        if (store(name).has(d._id)) throw new Error("dup");
        store(name).set(d._id, d);
      }
    },
  });
  return { stores, store, collection };
});

vi.mock("./db", () => ({
  getDb: async () => ({ collection: mongo.collection }),
}));

import { forkSession } from "./fork";

const SRC = "session_src";

function seed() {
  mongo.stores.clear();
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

describe("forkSession", () => {
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
