import { describe, expect, it } from "vitest";
import type {
  EntityExtractionResult,
  ExtractedEntity,
  EntityUpdate,
} from "@openflipbook/config";
import { __test } from "./world";

function makeAdded(overrides: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return {
    kind: "person",
    name: "Mira",
    appearance: "tall keeper in navy coat",
    confidence: 0.85,
    aliases: [],
    facts: [],
    state: {},
    ...overrides,
  };
}

function makeUpdate(overrides: Partial<EntityUpdate> = {}): EntityUpdate {
  return {
    match_name: "Mira",
    changes: {},
    confidence: 0.8,
    ...overrides,
  };
}

function emptyResult(): EntityExtractionResult {
  return { added: [], updated: [] };
}

describe("mergeIntoEntities", () => {
  it("adds a brand-new entity", () => {
    const out = __test.mergeIntoEntities([], "node-1", {
      ...emptyResult(),
      added: [makeAdded()],
    });
    expect(out.entities).toHaveLength(1);
    const e = out.entities[0]!;
    expect(e.name).toBe("Mira");
    expect(e.first_seen_node_id).toBe("node-1");
    expect(e.last_seen_node_id).toBe("node-1");
    expect(e.appears_on_node_ids).toEqual(["node-1"]);
    expect(out.added_ids).toHaveLength(1);
    expect(out.updated_ids).toHaveLength(0);
  });

  it("filters added entries below the confidence floor", () => {
    const out = __test.mergeIntoEntities([], "node-1", {
      ...emptyResult(),
      added: [makeAdded({ confidence: 0.1 })],
    });
    expect(out.entities).toHaveLength(0);
    expect(out.added_ids).toHaveLength(0);
  });

  it("reconciles a re-added existing entity into the same record", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      appears_on_node_ids: ["node-1"],
      facts: ["wears a peacoat"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      added: [
        makeAdded({
          name: "Mira",
          facts: ["holds a brass lantern"],
        }),
      ],
    });
    expect(out.entities).toHaveLength(1);
    const merged = out.entities[0]!;
    expect(merged.id).toBe("e1"); // not a new id
    expect(merged.appears_on_node_ids).toEqual(["node-1", "node-2"]);
    expect(merged.last_seen_node_id).toBe("node-2");
    expect(merged.facts).toEqual(
      expect.arrayContaining(["wears a peacoat", "holds a brass lantern"])
    );
    expect(out.added_ids).toHaveLength(0);
    expect(out.updated_ids).toEqual(["e1"]);
  });

  it("matches a re-added entity by alias", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Marian",
      aliases: ["Mira", "the Keeper"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      added: [makeAdded({ name: "Mira" })],
    });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.id).toBe("e1");
  });

  it("applies an updated entry by match_name", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      facts: [],
      state: {},
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: {
            facts: ["opened the lantern room"],
            // Use a canonical state key — Phase 7a restricts state writes
            // to the allow-list so per-entity state is renderable by the
            // planner's CAUSALITY clause.
            state: { open: true },
          },
        }),
      ],
    });
    expect(out.entities[0]!.facts).toEqual(["opened the lantern room"]);
    expect(out.entities[0]!.state).toEqual({ open: true });
    expect(out.updated_ids).toEqual(["e1"]);
  });

  it("matches updates case-insensitively", () => {
    const seed = __test.makeEntity({ id: "e1", name: "Mira" });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "MIRA",
          changes: { facts: ["new fact"] },
        }),
      ],
    });
    expect(out.entities[0]!.facts).toEqual(["new fact"]);
  });

  it("never auto-renames a user-pinned entity", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Marian",
      pinned_by_user: true,
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Marian",
          changes: { name: "Mira" },
        }),
      ],
    });
    expect(out.entities[0]!.name).toBe("Marian");
  });

  it("never overwrites a pinned entity's appearance", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      appearance: "weathered braid keeper",
      pinned_by_user: true,
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { appearance: "completely different" },
        }),
      ],
    });
    expect(out.entities[0]!.appearance).toBe("weathered braid keeper");
  });

  it("dedupes facts case-insensitively across appears", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      facts: ["Wears A Peacoat"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { facts: ["wears a peacoat", "holds a brass lantern"] },
        }),
      ],
    });
    expect(out.entities[0]!.facts).toEqual([
      "Wears A Peacoat",
      "holds a brass lantern",
    ]);
  });

  it("merges state objects, later writes win on the same key", () => {
    // Phase 7a — keys must be canonical (allow-list). `closed` and `open`
    // are both canonical so we can model a door flipping state on one
    // entity by mutating the boolean rather than packing a verb into
    // the key.
    const seed = __test.makeEntity({
      id: "e1",
      name: "Door",
      kind: "place",
      state: { closed: true },
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Door",
          changes: { state: { closed: false, open: true, lit: true } },
        }),
      ],
    });
    expect(out.entities[0]!.state).toEqual({
      closed: false,
      open: true,
      lit: true,
    });
  });

  it("appends the node id to appears_on without duplication", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      appears_on_node_ids: ["node-1", "node-2"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [makeUpdate({ match_name: "Mira", changes: { facts: ["x"] } })],
    });
    expect(out.entities[0]!.appears_on_node_ids).toEqual(["node-1", "node-2"]);
  });

  it("captures bbox from an added entity into appearance_bboxes for that node", () => {
    const out = __test.mergeIntoEntities([], "node-1", {
      ...emptyResult(),
      added: [
        makeAdded({
          bbox: { x_pct: 0.1, y_pct: 0.2, w_pct: 0.3, h_pct: 0.4 },
        }),
      ],
    });
    const e = out.entities[0]!;
    expect(e.appearance_bboxes["node-1"]).toEqual({
      x_pct: 0.1,
      y_pct: 0.2,
      w_pct: 0.3,
      h_pct: 0.4,
    });
  });

  it("merges bbox from a re-added existing entity under the new node id", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      appearance_bboxes: {
        "node-1": { x_pct: 0.1, y_pct: 0.1, w_pct: 0.2, h_pct: 0.2 },
      },
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      added: [
        makeAdded({
          name: "Mira",
          bbox: { x_pct: 0.5, y_pct: 0.5, w_pct: 0.2, h_pct: 0.2 },
        }),
      ],
    });
    const e = out.entities[0]!;
    expect(Object.keys(e.appearance_bboxes).sort()).toEqual([
      "node-1",
      "node-2",
    ]);
  });

  it("ratchets confidence upward, never down", () => {
    const seed = __test.makeEntity({ id: "e1", name: "Mira", confidence: 0.9 });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { facts: ["new"] },
          confidence: 0.5,
        }),
      ],
    });
    expect(out.entities[0]!.confidence).toBe(0.9);
  });

  it("treats an empty-changes update as a presence ping", () => {
    // Empty `changes` is intentionally preserved by the extraction parser
    // so the merge layer can bump last_seen / appears_on / confidence.
    // Without this, a recurring entity that didn't gain any new facts on
    // a turn would silently fall off the recency-based prior slice and
    // be re-added as a duplicate on the next page.
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      appears_on_node_ids: ["node-1"],
      facts: ["wears a peacoat"],
      confidence: 0.6,
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({ match_name: "Mira", changes: {}, confidence: 0.85 }),
      ],
    });
    expect(out.entities).toHaveLength(1);
    const e = out.entities[0]!;
    expect(e.appears_on_node_ids).toEqual(["node-1", "node-2"]);
    expect(e.last_seen_node_id).toBe("node-2");
    // No new facts; existing facts untouched.
    expect(e.facts).toEqual(["wears a peacoat"]);
    // Confidence ratchets upward off the ping.
    expect(e.confidence).toBe(0.85);
    expect(out.updated_ids).toEqual(["e1"]);
  });

  it("drops a presence-ping update below the confidence floor when target is not pinned", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      appears_on_node_ids: ["node-1"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({ match_name: "Mira", changes: {}, confidence: 0.1 }),
      ],
    });
    expect(out.entities[0]!.appears_on_node_ids).toEqual(["node-1"]);
    expect(out.updated_ids).toHaveLength(0);
  });

  it("keeps low-confidence presence pings on pinned entities", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      pinned_by_user: true,
      appears_on_node_ids: ["node-1"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({ match_name: "Mira", changes: {}, confidence: 0.1 }),
      ],
    });
    expect(out.entities[0]!.appears_on_node_ids).toEqual(["node-1", "node-2"]);
    expect(out.updated_ids).toEqual(["e1"]);
  });

  it("does not collapse a distinct later entity into a just-renamed record via stale key", () => {
    // Mira gets renamed Marian. Later in the same payload a distinct
    // `added: Mira` arrives (a NEW unrelated person who happens to share
    // the old name). Without stale-key cleanup the later add would
    // resolve to the renamed Marian via the leftover "mira" key. We
    // want them treated as separate records.
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      facts: ["wears a peacoat"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      added: [
        makeAdded({
          name: "Mira",
          appearance: "completely different person",
          confidence: 0.9,
        }),
      ],
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { name: "Marian" },
          confidence: 0.9,
        }),
      ],
    });
    expect(out.entities).toHaveLength(2);
    const names = out.entities.map((e) => e.name).sort();
    expect(names).toEqual(["Marian", "Mira"]);
    expect(out.added_ids).toHaveLength(1);
  });

  it("refreshes the name index when an update renames the entity mid-payload", () => {
    // Two entries in one payload: first renames "Mira" -> "Marian", then a
    // later `added` entry mentions "Marian". Without an in-payload index
    // refresh the second entry would create a duplicate. We assert it
    // reconciles into the just-renamed record instead.
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      facts: ["wears a peacoat"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      added: [
        makeAdded({
          name: "Marian",
          facts: ["holds a lantern"],
          confidence: 0.8,
        }),
      ],
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { name: "Marian" },
          confidence: 0.9,
        }),
      ],
    });
    expect(out.entities).toHaveLength(1);
    const e = out.entities[0]!;
    expect(e.name).toBe("Marian");
    expect(e.facts).toEqual(
      expect.arrayContaining(["wears a peacoat", "holds a lantern"])
    );
    expect(out.added_ids).toHaveLength(0);
  });
});

describe("Phase 7b — tombstone suppression", () => {
  it("suppresses presence pings against a tombstoned entity", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      deleted_at: new Date(),
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({ match_name: "Mira", changes: {}, confidence: 0.9 }),
      ],
    });
    // Tombstone untouched, no presence-ping bookkeeping.
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.deleted_at).toBeTruthy();
    expect(out.entities[0]!.appears_on_node_ids).toEqual(["node-1"]);
    expect(out.updated_ids).toHaveLength(0);
  });

  it("suppresses a fresh `added` by the same name as a tombstoned entity", () => {
    const seed = __test.makeEntity({
      id: "tombstoned",
      name: "Mira",
      deleted_at: new Date(),
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      added: [makeAdded({ name: "Mira", confidence: 0.95 })],
    });
    // Whack-a-mole break: re-add by name does not resurrect the entity
    // and does not create a duplicate.
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.id).toBe("tombstoned");
    expect(out.added_ids).toHaveLength(0);
  });
});

describe("Phase 7a — state-write gate", () => {
  it("drops low-confidence state writes but keeps the rest of the update", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      state: {},
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { state: { open: true }, facts: ["x"] },
          confidence: 0.4, // below MIN_STATE_WRITE_CONFIDENCE
        }),
      ],
    });
    // State diff dropped — facts (no confidence floor) still landed.
    expect(out.entities[0]!.state).toEqual({});
    expect(out.entities[0]!.facts).toEqual(["x"]);
  });

  it("filters out non-canonical state keys", () => {
    const seed = __test.makeEntity({ id: "e1", state: {} });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: {
            state: { open: true, totally_random_key: "x" },
          },
          confidence: 0.9,
        }),
      ],
    });
    expect(out.entities[0]!.state).toEqual({ open: true });
  });

  it("normalises common value variants (strings, casing, 1/0)", () => {
    const seed = __test.makeEntity({ id: "e1", state: {} });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: {
            state: {
              lit: "True",
              open: "OPEN",
              wounded: 1 as unknown as boolean,
              defeated: 0 as unknown as boolean,
            },
          },
          confidence: 0.9,
        }),
      ],
    });
    expect(out.entities[0]!.state).toEqual({
      lit: true,
      open: "open",
      wounded: true,
      defeated: false,
    });
  });

  it("pinned entities accept state writes regardless of confidence", () => {
    const seed = __test.makeEntity({
      id: "e1",
      pinned_by_user: true,
      state: {},
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { state: { open: true } },
          confidence: 0.3, // below floor; pinned bypass
        }),
      ],
    });
    expect(out.entities[0]!.state).toEqual({ open: true });
  });

  it("gates state on new `added` entities too", () => {
    // Low-confidence brand-new entity above the existence floor (0.3
    // for added) but below the state floor (0.6). The entity should
    // land, but with empty state — no junk seeded on day one.
    const out = __test.mergeIntoEntities([], "node-1", {
      ...emptyResult(),
      added: [
        makeAdded({
          name: "Newcomer",
          state: { open: true },
          confidence: 0.4,
        }),
      ],
    });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.state).toEqual({});
  });
});

describe("scoreEntitiesForContinuity", () => {
  function ent(overrides: Partial<import("@openflipbook/config").Entity> = {}) {
    return {
      id: overrides.id ?? "e1",
      kind: overrides.kind ?? ("person" as const),
      name: overrides.name ?? "Mira",
      aliases: overrides.aliases ?? [],
      appearance: overrides.appearance ?? "tall keeper",
      reference_image_url: overrides.reference_image_url ?? null,
      facts: overrides.facts ?? [],
      state: overrides.state ?? {},
      first_seen_node_id: overrides.first_seen_node_id ?? "n1",
      last_seen_node_id: overrides.last_seen_node_id ?? "n1",
      appears_on_node_ids: overrides.appears_on_node_ids ?? ["n1"],
      appearance_bboxes: overrides.appearance_bboxes ?? {},
      pinned_by_user: overrides.pinned_by_user ?? false,
      confidence: overrides.confidence ?? 0.7,
      updated_at: overrides.updated_at ?? new Date().toISOString(),
    };
  }

  it("matches by exact name and ignores noise", () => {
    const out = __test.scoreEntitiesForContinuity(
      [
        ent({ id: "a", name: "Mira" }),
        ent({ id: "b", name: "Hector" }),
      ],
      "Mira opens the lantern room door",
      null
    );
    expect(out.map((e) => e.id)).toContain("a");
    expect(out.map((e) => e.id)).not.toContain("b");
  });

  it("matches aliases", () => {
    const out = __test.scoreEntitiesForContinuity(
      [ent({ id: "a", name: "Marian", aliases: ["Mira", "the Keeper"] })],
      "the Keeper lights the lantern",
      null
    );
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });

  it("rejects substring-only false hits", () => {
    // "ana" in "banana" should not trigger an entity named "Ana".
    const out = __test.scoreEntitiesForContinuity(
      [ent({ id: "a", name: "Ana" })],
      "monkey eats a banana",
      null
    );
    expect(out).toEqual([]);
  });

  it("boosts pinned entities even without name overlap", () => {
    const out = __test.scoreEntitiesForContinuity(
      [
        ent({ id: "a", name: "Hector", pinned_by_user: true }),
        ent({ id: "b", name: "Mira" }),
      ],
      "the lantern flickers in the dark",
      null
    );
    expect(out.map((e) => e.id)).toContain("a");
  });

  it("boosts entities that appeared on the parent node", () => {
    const out = __test.scoreEntitiesForContinuity(
      [
        ent({
          id: "a",
          name: "Hector",
          last_seen_node_id: "parent-1",
          appears_on_node_ids: ["parent-1"],
        }),
        ent({ id: "b", name: "Mira" }),
      ],
      "the lantern flickers",
      "parent-1"
    );
    // Hector appeared on the parent → makes it into the continuity slice
    // even without a name match in the query.
    expect(out.map((e) => e.id)).toContain("a");
  });

  it("ranks higher-scoring entries first", () => {
    const out = __test.scoreEntitiesForContinuity(
      [
        ent({ id: "weak-recency", name: "Hector" }),
        ent({ id: "name-hit", name: "Mira" }),
        ent({
          id: "pinned-no-match",
          name: "Bartender",
          pinned_by_user: true,
        }),
      ],
      "Mira returns to the tavern",
      null
    );
    // Name match > pinned-no-match > weak-recency.
    expect(out[0]!.id).toBe("name-hit");
  });
});

describe("mergeEntitiesPure", () => {
  it("propagates pinned_by_user from source to target", () => {
    // A pinned record's curation flag must not silently drop when merged
    // into an unpinned survivor. Otherwise later extractor passes could
    // auto-rename / overwrite the appearance of the formerly curated
    // entity with no warning.
    const a = __test.makeEntity({
      id: "src",
      name: "Old Mira",
      pinned_by_user: true,
    });
    const b = __test.makeEntity({
      id: "tgt",
      name: "Mira",
      pinned_by_user: false,
    });
    const out = __test.mergeEntitiesPure([a, b], "src", "tgt");
    expect(out).toHaveLength(1);
    const survivor = out.find((e) => e.id === "tgt")!;
    expect(survivor.pinned_by_user).toBe(true);
    expect(survivor.aliases).toEqual(expect.arrayContaining(["Old Mira"]));
  });

  it("keeps target as pinned when only target was pinned", () => {
    const a = __test.makeEntity({ id: "src", pinned_by_user: false });
    const b = __test.makeEntity({
      id: "tgt",
      name: "Mira",
      pinned_by_user: true,
    });
    const out = __test.mergeEntitiesPure([a, b], "src", "tgt");
    expect(out.find((e) => e.id === "tgt")!.pinned_by_user).toBe(true);
  });

  it("merges appears_on without duplicates", () => {
    const a = __test.makeEntity({
      id: "src",
      appears_on_node_ids: ["n1", "n2"],
    });
    const b = __test.makeEntity({
      id: "tgt",
      appears_on_node_ids: ["n2", "n3"],
    });
    const out = __test.mergeEntitiesPure([a, b], "src", "tgt");
    const survivor = out.find((e) => e.id === "tgt")!;
    expect(survivor.appears_on_node_ids).toEqual(["n2", "n3", "n1"]);
  });

  it("target-wins on state-key conflicts", () => {
    // Curated state on the survivor must beat extractor-derived state
    // from the soon-to-be-deleted source. The applyUpdate path uses
    // incoming-wins; this path uses target-wins. Documented asymmetry.
    const a = __test.makeEntity({
      id: "src",
      state: { door: "closed", lit: false },
    });
    const b = __test.makeEntity({
      id: "tgt",
      state: { door: "open" },
    });
    const out = __test.mergeEntitiesPure([a, b], "src", "tgt");
    const survivor = out.find((e) => e.id === "tgt")!;
    expect(survivor.state).toEqual({ door: "open", lit: false });
  });
});
