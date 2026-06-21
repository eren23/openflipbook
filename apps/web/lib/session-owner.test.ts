import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the `session_owners` collection: insertOne enforces the
// unique _id (throws 11000 on a dup, like Mongo), findOne reads it back.
const store = new Map<string, { _id: string; owner_token: string }>();
const fakeCollection = {
  async insertOne(doc: { _id: string; owner_token: string }) {
    if (store.has(doc._id)) {
      const err = new Error("dup") as Error & { code?: number };
      err.code = 11000;
      throw err;
    }
    store.set(doc._id, doc);
    return { acknowledged: true };
  },
  async findOne(filter: { _id: string }) {
    return store.get(filter._id) ?? null;
  },
};

vi.mock("./db", () => ({
  getDb: async () => ({ collection: () => fakeCollection }),
}));

import { claimOrVerify } from "./session-owner";

describe("claimOrVerify (session ownership)", () => {
  beforeEach(() => store.clear());

  it("first caller claims an unowned session", async () => {
    expect(await claimOrVerify("s1", "tokenA")).toBe("ok");
    expect(store.get("s1")?.owner_token).toBe("tokenA");
  });

  it("the owner is re-verified ok on later calls", async () => {
    await claimOrVerify("s1", "tokenA");
    expect(await claimOrVerify("s1", "tokenA")).toBe("ok");
  });

  it("a different token is forbidden once the session is owned", async () => {
    await claimOrVerify("s1", "tokenA");
    expect(await claimOrVerify("s1", "tokenB")).toBe("forbidden");
  });

  it("a legacy (unowned) session is claimed by whoever writes first", async () => {
    // No prior claim → the first writer wins, later different tokens lose.
    expect(await claimOrVerify("legacy", "firstSeen")).toBe("ok");
    expect(await claimOrVerify("legacy", "stranger")).toBe("forbidden");
  });
});
