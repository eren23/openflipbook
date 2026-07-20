import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the `session_owners` collection: insertOne enforces the
// unique _id (throws 11000 on a dup, like Mongo), findOne reads it back. The
// knobs simulate the two failure modes claimOrVerify must distinguish: an
// unrelated insert error (rethrown) and a lost delete race (dup + missing doc).
const store = new Map<string, { _id: string; owner_token: string }>();
const knobs = { failInsert: null as "generic" | "dup" | null, findNull: false };
const fakeCollection = {
  async insertOne(doc: { _id: string; owner_token: string }) {
    if (knobs.failInsert === "generic") throw new Error("boom");
    if (knobs.failInsert === "dup" || store.has(doc._id)) {
      const err = new Error("dup") as Error & { code?: number };
      err.code = 11000;
      throw err;
    }
    store.set(doc._id, doc);
    return { acknowledged: true };
  },
  async findOne(filter: { _id: string }) {
    if (knobs.findNull) return null;
    return store.get(filter._id) ?? null;
  },
};

vi.mock("./db", () => ({
  getDb: async () => ({ collection: () => fakeCollection }),
}));

// Cookie jar behind the mocked next/headers (route-handler cookies() store).
const jar = vi.hoisted(() => ({
  token: null as string | null,
  sets: [] as { name: string; value: string; opts: Record<string, unknown> }[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.token ? { name, value: jar.token } : undefined),
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      jar.sets.push({ name, value, opts });
      jar.token = value;
    },
  }),
}));

import { claimOrVerify, requireOwner, verifyOwnerReadonly } from "./session-owner";

describe("claimOrVerify (session ownership)", () => {
  beforeEach(() => {
    store.clear();
    knobs.failInsert = null;
    knobs.findNull = false;
  });

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

  it("an unrelated insert error is rethrown, not swallowed as a dup", async () => {
    knobs.failInsert = "generic";
    await expect(claimOrVerify("s1", "tokenA")).rejects.toThrow("boom");
  });

  it("a lost delete race (dup insert, doc gone on re-read) is claimable", async () => {
    knobs.failInsert = "dup";
    knobs.findNull = true;
    expect(await claimOrVerify("s1", "tokenA")).toBe("ok");
  });
});

// ── The route gates (cookie mint + claim/verify + wire errors) ───────────────

const CONFIGURED = () => {
  vi.stubEnv("MONGODB_URI", "mongodb://test");
  vi.stubEnv("MONGODB_DB", "ofb_test");
};

describe("requireOwner (mutation gate)", () => {
  beforeEach(() => {
    store.clear();
    knobs.failInsert = null;
    knobs.findNull = false;
    jar.token = null;
    jar.sets.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects an unsafe session id with a 400 before touching anything", async () => {
    CONFIGURED();
    const out = await requireOwner("nope; drop table");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.res.status).toBe(400);
      expect(await out.res.json()).toEqual({ error: "invalid session id" });
    }
    expect(jar.sets).toHaveLength(0);
  });

  it("no persistence configured → open (demo mode must not crash)", async () => {
    vi.stubEnv("MONGODB_URI", "");
    vi.stubEnv("MONGODB_DB", "");
    expect(await requireOwner("session_1")).toEqual({ ok: true });
    expect(jar.sets).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("first write mints an httpOnly cookie and claims the session", async () => {
    CONFIGURED();
    const out = await requireOwner("session_1");
    expect(out.ok).toBe(true);
    expect(jar.sets).toHaveLength(1);
    const cookie = jar.sets[0]!;
    expect(cookie.name).toBe("ofb_owner");
    expect(cookie.opts.httpOnly).toBe(true);
    expect(cookie.opts.sameSite).toBe("lax");
    expect(store.get("session_1")?.owner_token).toBe(cookie.value);
  });

  it("the owner's later mutations pass without re-minting", async () => {
    CONFIGURED();
    jar.token = "mine";
    await claimOrVerify("session_1", "mine");
    expect(await requireOwner("session_1")).toEqual({ ok: true });
    expect(jar.sets).toHaveLength(0); // existing cookie reused
  });

  it("a stranger's cookie is rejected with the friendly 403", async () => {
    CONFIGURED();
    await claimOrVerify("session_1", "owner-token");
    jar.token = "stranger-token";
    const out = await requireOwner("session_1");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.res.status).toBe(403);
      expect(await out.res.json()).toEqual({
        error: "this session belongs to another browser",
      });
    }
  });
});

describe("verifyOwnerReadonly (streaming-route gate: never claims, never mints)", () => {
  beforeEach(() => {
    store.clear();
    knobs.failInsert = null;
    knobs.findNull = false;
    jar.token = null;
    jar.sets.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("unsafe id → 400; unconfigured store → open", async () => {
    CONFIGURED();
    const bad = await verifyOwnerReadonly("../etc/passwd");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.res.status).toBe(400);
    vi.stubEnv("MONGODB_URI", "");
    expect(await verifyOwnerReadonly("session_1")).toEqual({ ok: true });
  });

  it("an unowned session is allowed and left unclaimed (claim happens on write)", async () => {
    CONFIGURED();
    expect(await verifyOwnerReadonly("session_1")).toEqual({ ok: true });
    expect(store.size).toBe(0); // no claim
    expect(jar.sets).toHaveLength(0); // no cookie mint
  });

  it("an owned session admits the matching cookie and 403s everyone else", async () => {
    CONFIGURED();
    await claimOrVerify("session_1", "owner-token");
    jar.token = "owner-token";
    expect(await verifyOwnerReadonly("session_1")).toEqual({ ok: true });
    jar.token = "stranger";
    const wrong = await verifyOwnerReadonly("session_1");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.res.status).toBe(403);
    jar.token = null; // no cookie at all → same refusal
    const none = await verifyOwnerReadonly("session_1");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.res.status).toBe(403);
  });
});
