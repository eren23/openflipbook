import { describe, expect, it } from "vitest";
import type { Collection } from "mongodb";

import { optimisticReplace, type OptimisticDoc } from "./optimistic-update";

interface Doc extends OptimisticDoc {
  value: number;
}

const isDup = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;

const opts = (label = "test") => ({
  retryLimit: 4,
  isDuplicateKeyError: isDup,
  label,
});

// Minimal in-memory stand-in for the slice of Collection the helper touches
// (findOne / replaceOne filtered on updated_at / insertOne with dup-key). Hooks
// let a test inject a concurrent write between the read and the write.
class FakeCollection {
  store = new Map<string, Doc>();
  findOneCalls = 0;
  insertCalls = 0;
  replaceCalls = 0;
  // Runs after each findOne (simulates a racing writer landing first).
  onAfterRead: (() => void) | null = null;

  async findOne(filter: { _id: string }): Promise<Doc | null> {
    this.findOneCalls += 1;
    const doc = this.store.get(filter._id) ?? null;
    const hook = this.onAfterRead;
    this.onAfterRead = null;
    if (hook) hook();
    return doc ? { ...doc } : null;
  }

  async replaceOne(
    filter: { _id: string; updated_at: Date },
    next: Doc
  ): Promise<{ matchedCount: number }> {
    this.replaceCalls += 1;
    const cur = this.store.get(filter._id);
    // Optimistic filter: only match when the stored updated_at is unchanged.
    if (!cur || cur.updated_at.getTime() !== filter.updated_at.getTime()) {
      return { matchedCount: 0 };
    }
    this.store.set(filter._id, { ...next });
    return { matchedCount: 1 };
  }

  async insertOne(next: Doc): Promise<{ insertedId: string }> {
    this.insertCalls += 1;
    if (this.store.has(next._id)) {
      throw { code: 11000, message: "E11000 duplicate key" };
    }
    this.store.set(next._id, { ...next });
    return { insertedId: next._id };
  }
}

function asCol(fake: FakeCollection): Collection<Doc> {
  return fake as unknown as Collection<Doc>;
}

const build =
  (value: number) =>
  (existing: Doc | null): Doc => ({
    _id: "s1",
    value: existing ? existing.value + value : value,
    updated_at: new Date(),
  });

describe("optimisticReplace", () => {
  it("inserts a fresh doc on the first write", async () => {
    const fake = new FakeCollection();
    const out = await optimisticReplace(asCol(fake), "s1", build(7), opts());
    expect(out.value).toBe(7);
    expect(fake.insertCalls).toBe(1);
    expect(fake.replaceCalls).toBe(0);
    expect(fake.store.get("s1")!.value).toBe(7);
  });

  it("replaces an existing doc filtered on updated_at", async () => {
    const fake = new FakeCollection();
    fake.store.set("s1", { _id: "s1", value: 10, updated_at: new Date(1000) });
    const out = await optimisticReplace(asCol(fake), "s1", build(5), opts());
    expect(out.value).toBe(15);
    expect(fake.replaceCalls).toBe(1);
    expect(fake.insertCalls).toBe(0);
  });

  it("retries when a concurrent writer bumps updated_at between read and write", async () => {
    const fake = new FakeCollection();
    fake.store.set("s1", { _id: "s1", value: 1, updated_at: new Date(1000) });
    // First read sees updated_at=1000; before our replaceOne, a racing writer
    // lands a new doc with a different updated_at → our filtered replace misses
    // and we must re-read + re-apply against the NEW base.
    fake.onAfterRead = () => {
      fake.store.set("s1", { _id: "s1", value: 100, updated_at: new Date(2000) });
    };
    const out = await optimisticReplace(asCol(fake), "s1", build(5), opts());
    // Second attempt reads value=100 → 100+5.
    expect(out.value).toBe(105);
    expect(fake.findOneCalls).toBe(2);
    expect(fake.replaceCalls).toBe(2); // first missed, second matched
  });

  it("recovers from a lost first-write insert race via the loop", async () => {
    const fake = new FakeCollection();
    // No doc yet → first attempt takes the insert path, but a racing writer
    // creates the row just before our insert → duplicate-key → loop → the
    // re-read now sees the row and takes the replace path.
    fake.onAfterRead = () => {
      fake.store.set("s1", { _id: "s1", value: 42, updated_at: new Date(3000) });
    };
    const out = await optimisticReplace(asCol(fake), "s1", build(8), opts());
    expect(out.value).toBe(50); // 42 + 8 on the replace path
    expect(fake.insertCalls).toBe(1); // the failed insert
    expect(fake.replaceCalls).toBe(1); // the recovery replace
  });

  it("rethrows a non-duplicate-key insert error without looping", async () => {
    const boom = { code: 99, message: "some other mongo error" };
    let inserts = 0;
    const col = {
      findOne: async () => null,
      insertOne: async () => {
        inserts += 1;
        throw boom;
      },
    } as unknown as Collection<Doc>;
    await expect(
      optimisticReplace(col, "s1", build(1), opts())
    ).rejects.toBe(boom);
    expect(inserts).toBe(1); // threw on the first insert, no retry loop
  });

  it("throws a labelled error once the retry budget is exhausted", async () => {
    const fake = new FakeCollection();
    fake.store.set("s1", { _id: "s1", value: 1, updated_at: new Date(1000) });
    // Every read is followed by a racing bump, so the filtered replace never
    // matches → exhaust the budget.
    const col = {
      findOne: async () => {
        // Always hand back a stale base; the store always moves on after.
        const cur = fake.store.get("s1")!;
        fake.store.set("s1", { ...cur, updated_at: new Date(cur.updated_at.getTime() + 1) });
        return { ...cur };
      },
      replaceOne: async () => ({ matchedCount: 0 }),
    } as unknown as Collection<Doc>;
    await expect(
      optimisticReplace(col, "s1", build(1), opts("myLabel"))
    ).rejects.toThrow(
      "myLabel: optimistic concurrency retry exhausted for s1"
    );
  });
});
