import { describe, expect, it } from "vitest";
import type {
  EntityExtractionResult,
  ExtractedEntity,
  EntityUpdate,
} from "@openflipbook/config";
import { __test, mergeEntityState } from "./world";

// Same factory shapes as world.test.ts — kept local rather than re-exporting
// from the existing test file so the two suites stay independent.
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

describe("mergeEntityState (direct, exported)", () => {
  it("returns target unchanged when confidence is below the write floor and target is not pinned", () => {
    const target = { open: true };
    const out = mergeEntityState(target, { closed: true }, 0.5, false);
    expect(out).toBe(target);
  });

  it("accepts writes at the exact floor (>= MIN_STATE_WRITE_CONFIDENCE)", () => {
    const out = mergeEntityState({}, { open: true }, 0.6, false);
    expect(out).toEqual({ open: true });
  });

  it("drops non-canonical keys but keeps canonical ones in the same write", () => {
    const out = mergeEntityState(
      {},
      { open: true, totally_random: "x", lit: true },
      0.9,
      false
    );
    expect(out).toEqual({ open: true, lit: true });
  });

  it("lowercases & trims canonical keys before allow-list check", () => {
    const out = mergeEntityState({}, { "  OPEN  ": true }, 0.9, false);
    expect(out).toEqual({ open: true });
  });

  it("pinned target bypasses the confidence floor but key filter still applies", () => {
    const out = mergeEntityState(
      {},
      { open: true, junk_key: "x" },
      0.1,
      true
    );
    expect(out).toEqual({ open: true });
  });

  it("normalises string truthiness variants", () => {
    const out = mergeEntityState(
      {},
      { lit: "yes", open: "no", burning: "TRUE", closed: "False" },
      0.9,
      false
    );
    expect(out).toEqual({
      lit: true,
      open: false,
      burning: true,
      closed: false,
    });
  });

  it("normalises numeric 1/0 to booleans, keeps other numbers as-is", () => {
    const out = mergeEntityState(
      {},
      { open: 1 as unknown as boolean, lit: 0 as unknown as boolean, time: 14 },
      0.9,
      false
    );
    expect(out).toEqual({ open: true, lit: false, time: 14 });
  });

  it("drops empty / whitespace-only string values entirely", () => {
    const out = mergeEntityState(
      { open: true },
      { open: "   ", lit: "" },
      0.9,
      false
    );
    // The empty string for `open` short-circuits as undefined and is NOT
    // written; pre-existing `open: true` survives. `lit` likewise dropped.
    expect(out).toEqual({ open: true });
  });

  it("keeps long string values intact (no lowercasing past 24 chars)", () => {
    const longVal = "A".repeat(25);
    const out = mergeEntityState({}, { location: longVal }, 0.9, false);
    expect(out).toEqual({ location: longVal });
  });

  it("lowercases short string values for cache-friendly prompts", () => {
    const out = mergeEntityState({}, { posture: "Standing" }, 0.9, false);
    expect(out).toEqual({ posture: "standing" });
  });

  it("does not mutate the target object", () => {
    const target = { open: true };
    const out = mergeEntityState(target, { lit: true }, 0.9, false);
    expect(target).toEqual({ open: true });
    expect(out).not.toBe(target);
  });
});

describe("mergeIntoEntities — additional coverage", () => {
  it("truncates added.facts to MAX_FACTS_PER_ENTITY (12)", () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => `fact-${i}`);
    const out = __test.mergeIntoEntities([], "node-1", {
      ...emptyResult(),
      added: [makeAdded({ facts: tooMany })],
    });
    expect(out.entities[0]!.facts).toHaveLength(12);
    // Order preserved within the truncated slice.
    expect(out.entities[0]!.facts[0]).toBe("fact-0");
    expect(out.entities[0]!.facts[11]).toBe("fact-11");
  });

  it("truncates merged updated.facts to MAX_FACTS_PER_ENTITY", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      facts: ["existing-1", "existing-2"],
    });
    const incoming = Array.from({ length: 20 }, (_, i) => `new-${i}`);
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { facts: incoming },
        }),
      ],
    });
    expect(out.entities[0]!.facts).toHaveLength(12);
    // Existing entries take the front slots; truncation drops the tail.
    expect(out.entities[0]!.facts[0]).toBe("existing-1");
    expect(out.entities[0]!.facts[1]).toBe("existing-2");
  });

  it("dedupes incoming aliases against existing aliases (case-insensitive)", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      aliases: ["Keeper"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { aliases: ["keeper", "Watcher"] },
        }),
      ],
    });
    expect(out.entities[0]!.aliases).toEqual(["Keeper", "Watcher"]);
  });

  it("matches an updated entry via alias key, not just primary name", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Marian",
      aliases: ["the Keeper"],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "the keeper", // lowercase, alias match
          changes: { facts: ["lit the lantern"] },
        }),
      ],
    });
    expect(out.entities[0]!.facts).toEqual(["lit the lantern"]);
  });

  it("drops an `updated` entry that doesn't resolve to any entity", () => {
    const seed = __test.makeEntity({ id: "e1", name: "Mira" });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Nobody",
          changes: { facts: ["ghost fact"] },
        }),
      ],
    });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.facts).toEqual([]);
    expect(out.updated_ids).toHaveLength(0);
  });

  it("ignores low-confidence updated entries against non-pinned targets", () => {
    const seed = __test.makeEntity({ id: "e1", name: "Mira", facts: [] });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { facts: ["should be dropped"] },
          confidence: 0.1, // below MIN_ADDED_CONFIDENCE
        }),
      ],
    });
    expect(out.entities[0]!.facts).toEqual([]);
    expect(out.updated_ids).toHaveLength(0);
  });

  it("processes low-confidence updated entries when target is pinned", () => {
    const seed = __test.makeEntity({
      id: "e1",
      name: "Mira",
      pinned_by_user: true,
      facts: [],
    });
    const out = __test.mergeIntoEntities([seed], "node-2", {
      ...emptyResult(),
      updated: [
        makeUpdate({
          match_name: "Mira",
          changes: { facts: ["pinned override"] },
          confidence: 0.1,
        }),
      ],
    });
    expect(out.entities[0]!.facts).toEqual(["pinned override"]);
  });
});

describe("mergeEntitiesPure — additional coverage", () => {
  it("noops when sourceId is missing", () => {
    const a = __test.makeEntity({ id: "tgt" });
    const out = __test.mergeEntitiesPure([a], "missing-src", "tgt");
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("tgt");
  });

  it("noops when targetId is missing", () => {
    const a = __test.makeEntity({ id: "src" });
    const out = __test.mergeEntitiesPure([a], "src", "missing-tgt");
    // Source still present; no destructive splice on bad input.
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("src");
  });

  it("folds source.name into target.aliases and dedupes against existing aliases", () => {
    const a = __test.makeEntity({
      id: "src",
      name: "Mira",
      aliases: ["keeper"],
    });
    const b = __test.makeEntity({
      id: "tgt",
      name: "Marian",
      aliases: ["Keeper"], // case-insensitive dedupe vs source's "keeper"
    });
    const out = __test.mergeEntitiesPure([a, b], "src", "tgt");
    const survivor = out.find((e) => e.id === "tgt")!;
    expect(survivor.aliases).toEqual(["Keeper", "Mira"]);
  });

  it("truncates merged facts to MAX_FACTS_PER_ENTITY", () => {
    const a = __test.makeEntity({
      id: "src",
      facts: Array.from({ length: 10 }, (_, i) => `src-${i}`),
    });
    const b = __test.makeEntity({
      id: "tgt",
      facts: Array.from({ length: 10 }, (_, i) => `tgt-${i}`),
    });
    const out = __test.mergeEntitiesPure([a, b], "src", "tgt");
    const survivor = out.find((e) => e.id === "tgt")!;
    expect(survivor.facts).toHaveLength(12);
    // Target facts take the front slots.
    expect(survivor.facts.slice(0, 10)).toEqual(b.facts);
  });
});

describe("scoreEntitiesForContinuity — additional coverage", () => {
  it("returns [] for an empty input array", () => {
    const out = __test.scoreEntitiesForContinuity([], "any query", null);
    expect(out).toEqual([]);
  });

  it("returns [] when no entity has any signal (no name/alias/parent/pin match)", () => {
    const out = __test.scoreEntitiesForContinuity(
      [ent({ id: "a", name: "Hector" }), ent({ id: "b", name: "Lyra" })],
      "the door creaks open in the empty hall",
      null
    );
    expect(out).toEqual([]);
  });

  it("uses recency as a tiebreaker among entries with identical signal", () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString();
    const out = __test.scoreEntitiesForContinuity(
      [
        ent({ id: "stale", name: "Mira", updated_at: stale }),
        ent({ id: "fresh", name: "Mira", updated_at: fresh }),
      ],
      "Mira walks in",
      null
    );
    // Both score 1.0 on the name hit; recency boost (max 0.1) ranks fresh first.
    expect(out[0]!.id).toBe("fresh");
    expect(out[1]!.id).toBe("stale");
  });

  it("scores parent-node-last-seen higher than parent-node-appears-only", () => {
    const out = __test.scoreEntitiesForContinuity(
      [
        ent({
          id: "appears-only",
          name: "Hector",
          last_seen_node_id: "other",
          appears_on_node_ids: ["other", "parent-1"],
        }),
        ent({
          id: "last-seen",
          name: "Hector",
          last_seen_node_id: "parent-1",
          appears_on_node_ids: ["parent-1"],
        }),
      ],
      "anonymous query",
      "parent-1"
    );
    // last_seen on parent (+0.5 +0.3) outranks appears-only on parent (+0.3).
    expect(out[0]!.id).toBe("last-seen");
    expect(out[1]!.id).toBe("appears-only");
  });

  it("handles a malformed updated_at without throwing (treated as very old)", () => {
    // ageHoursFromIso returns 1_000_000 for NaN; exp(-large) ≈ 0, so the
    // recency tiebreak collapses to 0 but the entity still scores via name.
    const out = __test.scoreEntitiesForContinuity(
      [ent({ id: "a", name: "Mira", updated_at: "not-a-date" })],
      "Mira opens the door",
      null
    );
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });
});
