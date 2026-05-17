import { describe, expect, it } from "vitest";
import type { Entity, WorldStateSnapshot } from "@openflipbook/config";
import { __test } from "./useWorldState";

const { reducer, initialState, makeStubEntity } = __test;

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: overrides.id ?? "e1",
    kind: overrides.kind ?? "person",
    name: overrides.name ?? "Mira",
    aliases: overrides.aliases ?? [],
    appearance: overrides.appearance ?? "tall keeper in navy coat",
    reference_image_url: overrides.reference_image_url ?? null,
    facts: overrides.facts ?? [],
    state: overrides.state ?? {},
    first_seen_node_id: overrides.first_seen_node_id ?? "n1",
    last_seen_node_id: overrides.last_seen_node_id ?? "n1",
    appears_on_node_ids: overrides.appears_on_node_ids ?? ["n1"],
    appearance_bboxes: overrides.appearance_bboxes ?? {},
    pinned_by_user: overrides.pinned_by_user ?? false,
    confidence: overrides.confidence ?? 0.8,
    updated_at: overrides.updated_at ?? new Date().toISOString(),
  };
}

function makeSnapshot(entities: Entity[]): WorldStateSnapshot {
  return {
    session_id: "s1",
    entities,
    updated_at: new Date().toISOString(),
  };
}

describe("useWorldState reducer", () => {
  it("loaded replaces entities and clears error", () => {
    const next = reducer(
      { ...initialState, loading: true, error: "old error" },
      { type: "loaded", snapshot: makeSnapshot([makeEntity()]) }
    );
    expect(next.entities).toHaveLength(1);
    expect(next.loading).toBe(false);
    expect(next.error).toBeNull();
  });

  it("failed keeps existing entities and sets error", () => {
    const before = reducer(initialState, {
      type: "loaded",
      snapshot: makeSnapshot([makeEntity()]),
    });
    const next = reducer(before, { type: "failed", error: "boom" });
    expect(next.entities).toHaveLength(1);
    expect(next.error).toBe("boom");
    expect(next.loading).toBe(false);
  });

  it("extraction_event optimistically adds new entities by digest", () => {
    const before = reducer(initialState, {
      type: "loaded",
      snapshot: makeSnapshot([]),
    });
    const next = reducer(before, {
      type: "extraction_event",
      added: [{ id: "newE", name: "Newcomer", kind: "person" }],
      updated: [],
    });
    expect(next.entities).toHaveLength(1);
    expect(next.entities[0]!.id).toBe("newE");
    expect(next.entities[0]!.name).toBe("Newcomer");
    expect(next.entities[0]!.appearance).toBe(""); // stub
  });

  it("extraction_event ignores duplicates already present", () => {
    const before = reducer(initialState, {
      type: "loaded",
      snapshot: makeSnapshot([makeEntity({ id: "e1", name: "Mira" })]),
    });
    const next = reducer(before, {
      type: "extraction_event",
      added: [{ id: "e1", name: "Mira", kind: "person" }],
      updated: [],
    });
    expect(next.entities).toHaveLength(1);
    // The full entity is preserved — extraction_event must NOT clobber a
    // hydrated record with a thin stub.
    expect(next.entities[0]!.appearance).toBe("tall keeper in navy coat");
  });

  it("extraction_event with no diff is a no-op (no rerender churn)", () => {
    const before = reducer(initialState, {
      type: "loaded",
      snapshot: makeSnapshot([makeEntity()]),
    });
    const next = reducer(before, {
      type: "extraction_event",
      added: [],
      updated: [],
    });
    expect(next).toBe(before);
  });

  it("extraction_event marks an updated entity as resolving until refetch", () => {
    const before = reducer(initialState, {
      type: "loaded",
      snapshot: makeSnapshot([
        makeEntity({ id: "e1", name: "Mira", appearance: "old descriptor" }),
      ]),
    });
    const next = reducer(before, {
      type: "extraction_event",
      added: [],
      updated: [{ id: "e1", name: "Mira", kind: "person" }],
    });
    // Appearance blanked → codex shows resolving spinner until the
    // debounced canonical refetch lands.
    expect(next.entities[0]!.appearance).toBe("");
  });

  it("extraction_event with only existing ids and no field change is a no-op", () => {
    // Edge case: optimistic event arrives but `updated` references an
    // already-stub entity (appearance already ""). No state change, so
    // the reducer must return the same object reference to avoid
    // re-rendering the codex panel for nothing.
    const before = reducer(initialState, {
      type: "loaded",
      snapshot: makeSnapshot([makeEntity({ id: "e1", appearance: "" })]),
    });
    const next = reducer(before, {
      type: "extraction_event",
      added: [{ id: "e1", name: "Mira", kind: "person" }],
      updated: [{ id: "e1", name: "Mira", kind: "person" }],
    });
    expect(next).toBe(before);
  });

  it("loaded propagates override_enabled when present", () => {
    const next = reducer(initialState, {
      type: "loaded",
      snapshot: makeSnapshot([]),
      override_enabled: true,
    });
    expect(next.overrideEnabled).toBe(true);
  });

  it("loaded keeps previous override_enabled when the field is absent", () => {
    const first = reducer(initialState, {
      type: "loaded",
      snapshot: makeSnapshot([]),
      override_enabled: true,
    });
    // Subsequent refresh response that omits override_enabled (legacy)
    // should not flip the flag back to false.
    const next = reducer(first, {
      type: "loaded",
      snapshot: makeSnapshot([]),
    });
    expect(next.overrideEnabled).toBe(true);
  });

  it("Phase 7b — mark_recently_deleted records id → name", () => {
    const next = reducer(initialState, {
      type: "mark_recently_deleted",
      id: "e1",
      name: "Mira",
    });
    expect(next.recentlyDeleted.get("e1")).toBe("Mira");
  });

  it("Phase 7b — clear_recently_deleted evicts BOTH id and its name", () => {
    const marked = reducer(initialState, {
      type: "mark_recently_deleted",
      id: "e1",
      name: "Torch",
    });
    const cleared = reducer(marked, {
      type: "clear_recently_deleted",
      id: "e1",
    });
    expect(cleared.recentlyDeleted.has("e1")).toBe(false);
    // The name suppression must lift too — otherwise a long session
    // accumulates name-suppressions for unrelated entities that happen
    // to reuse a name. Reviewer-flagged regression case.
    const reAdd = reducer(cleared, {
      type: "extraction_event",
      added: [{ id: "fresh", name: "Torch", kind: "item" }],
      updated: [],
    });
    expect(reAdd.entities.find((e) => e.id === "fresh")).toBeTruthy();
    // No-op when id wasn't recently deleted — returns same reference.
    const cleared2 = reducer(cleared, {
      type: "clear_recently_deleted",
      id: "missing",
    });
    expect(cleared2).toBe(cleared);
  });

  it("Phase 7b — extraction_event drops stubs for recently-deleted ids", () => {
    const seeded = reducer(initialState, {
      type: "mark_recently_deleted",
      id: "tombstoned",
      name: "Mira",
    });
    const next = reducer(seeded, {
      type: "extraction_event",
      added: [{ id: "tombstoned", name: "Mira", kind: "person" }],
      updated: [],
    });
    // Reducer must not zombie a tombstoned entity back into the codex.
    expect(next.entities.find((e) => e.id === "tombstoned")).toBeUndefined();
    expect(next).toBe(seeded); // same ref → no codex re-render
  });

  it("Phase 7b — extraction_event drops stubs by recently-deleted name", () => {
    // The just-deleted entity gets a fresh extractor id (because the
    // extractor doesn't know the tombstoned id); we still drop by name.
    const seeded = reducer(initialState, {
      type: "mark_recently_deleted",
      id: "old-id",
      name: "Mira",
    });
    const next = reducer(seeded, {
      type: "extraction_event",
      added: [{ id: "brand-new-id", name: "Mira", kind: "person" }],
      updated: [],
    });
    expect(next).toBe(seeded);
  });

  it("makeStubEntity has empty appearance so codex can mark resolving state", () => {
    const stub = makeStubEntity({ id: "x", name: "X", kind: "creature" });
    expect(stub.appearance).toBe("");
    expect(stub.confidence).toBe(0);
    expect(stub.kind).toBe("creature");
  });
});
