import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, { _id: string; result?: unknown }>();
const fakeCollection = {
  async insertOne(doc: { _id: string }) {
    if (store.has(doc._id)) {
      const err = new Error("dup") as Error & { code?: number };
      err.code = 11000;
      throw err;
    }
    store.set(doc._id, { ...doc });
    return { acknowledged: true };
  },
  async findOne(f: { _id: string }) {
    return store.get(f._id) ?? null;
  },
  async deleteOne(f: { _id: string }) {
    const had = store.delete(f._id);
    return { deletedCount: had ? 1 : 0 };
  },
  async updateOne(
    f: { _id: string },
    update: { $set?: Record<string, unknown> },
    opts?: { upsert?: boolean },
  ) {
    let d = store.get(f._id);
    if (!d) {
      if (!opts?.upsert) return { matchedCount: 0 };
      d = { _id: f._id };
      store.set(f._id, d);
    }
    Object.assign(d, update.$set ?? {});
    return { matchedCount: 1 };
  },
};

vi.mock("./db", () => ({
  getDb: async () => ({ collection: () => fakeCollection }),
}));

import {
  claimIdempotencyKey,
  getIdempotentResult,
  releaseIdempotencyKey,
  saveIdempotentResult,
} from "./idempotency";

const ENV = { ...process.env };

beforeEach(() => {
  store.clear();
  process.env.MONGODB_URI = "mongodb://x";
  process.env.MONGODB_DB = "y";
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("idempotency", () => {
  it("first claim is fresh, a replay is a duplicate", async () => {
    expect(await claimIdempotencyKey("gen:abc")).toBe("fresh");
    expect(await claimIdempotencyKey("gen:abc")).toBe("duplicate");
  });

  it("a released key can be claimed fresh again", async () => {
    expect(await claimIdempotencyKey("gen:abc")).toBe("fresh");
    expect(await claimIdempotencyKey("gen:abc")).toBe("duplicate");
    await releaseIdempotencyKey("gen:abc"); // a failed gen frees the key
    expect(await claimIdempotencyKey("gen:abc")).toBe("fresh");
  });

  it("result cache round-trips for replays", async () => {
    await saveIdempotentResult("node:k1", { id: "n1", image_url: "u" });
    expect(await getIdempotentResult("node:k1")).toEqual({
      id: "n1",
      image_url: "u",
    });
    expect(await getIdempotentResult("node:missing")).toBeNull();
  });

  it("fails open (fresh) when Mongo is unconfigured", async () => {
    delete process.env.MONGODB_URI;
    expect(await claimIdempotencyKey("gen:x")).toBe("fresh");
    expect(await getIdempotentResult("node:x")).toBeNull();
  });
});
