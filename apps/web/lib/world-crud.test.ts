import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity } from "@openflipbook/config";

// In-memory `world_state` collection so the optimistic mutate() wrappers and
// the read slices run for real without MongoDB (same stand-in shape as the
// world-map suite): findOne, insertOne with unique-_id 11000, replaceOne
// filtered on the seen updated_at.
const mongo = vi.hoisted(() => {
  const docs = new Map<string, { _id: string; updated_at: Date } & Record<string, unknown>>();
  const state = { failFind: false };
  const col = {
    async findOne(filter: { _id: string }) {
      if (state.failFind) throw new Error("db down");
      return docs.get(filter._id) ?? null;
    },
    async insertOne(doc: { _id: string; updated_at: Date }) {
      if (docs.has(doc._id)) {
        const err = new Error("dup") as Error & { code?: number };
        err.code = 11000;
        throw err;
      }
      docs.set(doc._id, doc);
      return { acknowledged: true };
    },
    async replaceOne(filter: { _id: string; updated_at: Date }, next: { _id: string; updated_at: Date }) {
      const cur = docs.get(filter._id);
      if (!cur || cur.updated_at.getTime() !== filter.updated_at.getTime()) {
        return { matchedCount: 0 };
      }
      docs.set(filter._id, next);
      return { matchedCount: 1 };
    },
  };
  return { docs, state, col };
});

vi.mock("./db", () => ({
  getDb: async () => ({ collection: () => mongo.col }),
}));

import {
  deleteEntity,
  getWorldState,
  listPriorEntitiesForExtraction,
  mergeEntities,
  pinEntity,
  renameEntity,
  resolveEntitiesForPrompt,
  setEntityAppearance,
  undoDeleteEntity,
} from "./world";

// EntityDoc factory (the stored shape; entityToWire maps it to the wire Entity).
function doc(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "person",
    name: id,
    aliases: [] as string[],
    appearance: "",
    reference_image_url: null,
    facts: [] as string[],
    state: {},
    first_seen_node_id: "n1",
    last_seen_node_id: "n1",
    appears_on_node_ids: ["n1"],
    appearance_bboxes: {},
    appearance_borders: {},
    pinned_by_user: false,
    confidence: 0.9,
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function seed(sessionId: string, entities: Record<string, unknown>[]) {
  mongo.docs.set(sessionId, {
    _id: sessionId,
    entities,
    updated_at: new Date("2026-01-01T00:00:00Z"),
    schema_version: 1,
  });
}

beforeEach(() => {
  mongo.docs.clear();
  mongo.state.failFind = false;
});

describe("getWorldState", () => {
  it("unknown session → empty snapshot at epoch", async () => {
    const snap = await getWorldState("s_missing");
    expect(snap).toEqual({
      session_id: "s_missing",
      entities: [],
      updated_at: new Date(0).toISOString(),
    });
  });

  it("hides tombstoned entities from snapshot readers", async () => {
    seed("s1", [doc("Alice"), doc("Ghost", { deleted_at: new Date() })]);
    const snap = await getWorldState("s1");
    expect(snap.entities.map((e) => e.name)).toEqual(["Alice"]);
    expect(snap.entities[0]!.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("user-override CRUD (optimistic mutate path)", () => {
  it("pinEntity flips the flag; an unknown id is a safe no-op", async () => {
    seed("s1", [doc("Alice")]);
    const snap = await pinEntity("s1", "Alice", true);
    expect(snap.entities[0]!.pinned_by_user).toBe(true);
    const noop = await pinEntity("s1", "nobody", true);
    expect(noop.entities.map((e) => e.pinned_by_user)).toEqual([true]);
  });

  it("renameEntity demotes the old name to aliases and never self-aliases", async () => {
    seed("s1", [doc("Alice", { aliases: ["Al"] })]);
    const snap = await renameEntity("s1", "Alice", "  Alicia  ", null);
    const e = snap.entities[0]!;
    expect(e.name).toBe("Alicia");
    expect(e.aliases).toEqual(["Al", "Alice"]);
    // Renaming BACK: the new primary name must not survive as its own alias.
    const back = await renameEntity("s1", "Alice", "Alice", null);
    expect(back.entities[0]!.name).toBe("Alice");
    expect(back.entities[0]!.aliases).not.toContain("Alice");
  });

  it("renameEntity rejects an empty name", async () => {
    seed("s1", [doc("Alice")]);
    await expect(renameEntity("s1", "Alice", "   ", null)).rejects.toThrow(
      "name cannot be empty",
    );
  });

  it("delete tombstones (hidden from reads) and undo restores", async () => {
    seed("s1", [doc("Alice"), doc("Bob")]);
    await deleteEntity("s1", "Bob");
    expect((await getWorldState("s1")).entities.map((e) => e.name)).toEqual(["Alice"]);
    await undoDeleteEntity("s1", "Bob");
    expect((await getWorldState("s1")).entities.map((e) => e.name).sort()).toEqual([
      "Alice",
      "Bob",
    ]);
  });

  it("setEntityAppearance trims + stores the reference image; empty rejects", async () => {
    seed("s1", [doc("Alice")]);
    const snap = await setEntityAppearance("s1", "Alice", "  red cloak ", "https://img/x.png");
    expect(snap.entities[0]!.appearance).toBe("red cloak");
    expect(snap.entities[0]!.reference_image_url).toBe("https://img/x.png");
    await expect(setEntityAppearance("s1", "Alice", "  ", null)).rejects.toThrow(
      "appearance cannot be empty",
    );
  });

  it("mergeEntities consolidates into the target and removes the source", async () => {
    seed("s1", [
      doc("Alice", {
        aliases: ["Al"],
        facts: ["carries a lamp"],
        state: { posture: "sitting" },
        appears_on_node_ids: ["n1"],
      }),
      doc("Alicia", {
        aliases: ["Ali"],
        facts: ["wears a red cloak"],
        state: { posture: "standing", lit: true },
        appears_on_node_ids: ["n2"],
        pinned_by_user: true,
      }),
    ]);
    const snap = await mergeEntities("s1", "Alicia", "Alice");
    expect(snap.entities.map((e) => e.name)).toEqual(["Alice"]);
    const merged = snap.entities[0]!;
    expect(merged.aliases).toEqual(["Al", "Alicia", "Ali"]);
    expect(merged.facts).toEqual(["carries a lamp", "wears a red cloak"]);
    // Target-wins on shared keys; source-only keys survive.
    expect(merged.state).toEqual({ posture: "sitting", lit: true });
    expect(merged.appears_on_node_ids).toEqual(["n1", "n2"]);
    expect(merged.pinned_by_user).toBe(true); // pin propagates from source
  });

  it("mergeEntities with self or a missing record changes nothing", async () => {
    seed("s1", [doc("Alice")]);
    const self = await mergeEntities("s1", "Alice", "Alice");
    expect(self.entities).toHaveLength(1);
    const ghost = await mergeEntities("s1", "nobody", "Alice");
    expect(ghost.entities.map((e) => e.name)).toEqual(["Alice"]);
  });
});

describe("resolveEntitiesForPrompt (planner continuity slice)", () => {
  it("empty registry / no doc → []", async () => {
    expect(await resolveEntitiesForPrompt({ sessionId: "s_missing", query: "q" })).toEqual([]);
    seed("s1", [doc("Ghost", { deleted_at: new Date() })]);
    expect(await resolveEntitiesForPrompt({ sessionId: "s1", query: "q" })).toEqual([]);
  });

  it("ships the slim context shape and never a tombstone", async () => {
    seed("s1", [
      doc("Alice", { appearance: "red cloak", state: { posture: "sitting" } }),
      doc("Ghost", { deleted_at: new Date() }),
    ]);
    const out = await resolveEntitiesForPrompt({
      sessionId: "s1",
      query: "Alice enters the hall",
      parentTitle: "The Hall",
    });
    expect(out).toEqual([
      {
        id: "Alice",
        kind: "person",
        name: "Alice",
        aliases: [],
        appearance: "red cloak",
        reference_image_url: null,
        state: { posture: "sitting" },
      },
    ]);
  });

  it("best-effort: a DB failure resolves to [] instead of breaking generation", async () => {
    mongo.state.failFind = true;
    expect(await resolveEntitiesForPrompt({ sessionId: "s1", query: "q" })).toEqual([]);
  });
});

describe("listPriorEntitiesForExtraction (prior slice scoring)", () => {
  it("no doc / all tombstoned → []", async () => {
    expect(await listPriorEntitiesForExtraction("s_missing")).toEqual([]);
    seed("s1", [doc("Ghost", { deleted_at: new Date() })]);
    expect(await listPriorEntitiesForExtraction("s1")).toEqual([]);
  });

  it("caption whole-word hits outrank recency; substring-only hits do not", async () => {
    seed("s1", [
      doc("Ana", { aliases: ["Annie"], updated_at: new Date("2026-01-01") }),
      doc("Fresh", { updated_at: new Date("2026-06-01") }),
    ]);
    // "banana" contains "ana" but not as a word → Fresh keeps the top slot.
    const noHit = await listPriorEntitiesForExtraction("s1", "a banana stand");
    expect(noHit.map((e) => e.name)).toEqual(["Fresh", "Ana"]);
    // A real word-boundary mention (name + alias) pulls the stale entity front.
    const hit = await listPriorEntitiesForExtraction("s1", "Ana, called Annie, waves");
    expect(hit.map((e) => e.name)).toEqual(["Ana", "Fresh"]);
    expect(hit[0]).toEqual({
      id: "Ana",
      kind: "person",
      name: "Ana",
      aliases: ["Annie"],
      appearance: "",
    });
  });

  it("alias mentions score too (recency held equal)", async () => {
    const t = new Date("2026-03-01");
    seed("s1", [
      doc("Bystander", { updated_at: t }),
      doc("Old Sailor", { aliases: ["the captain"], updated_at: t }),
    ]);
    const out = await listPriorEntitiesForExtraction("s1", "the captain steers");
    expect(out.map((e) => e.name)).toEqual(["Old Sailor", "Bystander"]);
  });
});

// Type-level guard that the wire mapping above stays the real Entity shape.
const _wireCheck = (e: Entity): string => e.id;
void _wireCheck;
