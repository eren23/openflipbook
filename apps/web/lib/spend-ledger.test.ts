import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateRequestBody } from "@openflipbook/config";

// In-memory stand-in supporting findOne + updateOne($inc/$set, upsert).
const docs = new Map<string, { _id: string; total?: number }>();
const fakeCollection = {
  async findOne(f: { _id: string }) {
    return docs.get(f._id) ?? null;
  },
  async updateOne(
    f: { _id: string },
    update: { $inc?: { total?: number }; $set?: Record<string, unknown> },
    opts?: { upsert?: boolean },
  ) {
    let d = docs.get(f._id);
    if (!d) {
      if (!opts?.upsert) return { matchedCount: 0 };
      d = { _id: f._id };
      docs.set(f._id, d);
    }
    if (update.$inc?.total) d.total = (d.total ?? 0) + update.$inc.total;
    return { matchedCount: 1 };
  },
};

vi.mock("./db", () => ({
  getDb: async () => ({ collection: () => fakeCollection }),
}));

import {
  estimateGenerationCost,
  recordSpend,
  spendOverCap,
} from "./spend-ledger";

const ENV = { ...process.env };

function body(over: Partial<GenerateRequestBody>): GenerateRequestBody {
  return {
    query: "q",
    aspect_ratio: "16:9",
    web_search: false,
    session_id: "s1",
    current_node_id: "",
    ...over,
  } as GenerateRequestBody;
}

beforeEach(() => {
  docs.clear();
  process.env.MONGODB_URI = "mongodb://x";
  process.env.MONGODB_DB = "y";
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("spend-ledger (durable cross-container cap)", () => {
  it("is a no-op when no cap is configured", async () => {
    await recordSpend("s1", 100);
    expect(await spendOverCap("s1")).toBeNull();
  });

  it("daily cap is global — blocks even a session that never spent", async () => {
    process.env.MAX_DAILY_SPEND = "1";
    await recordSpend("s1", 1.5);
    expect(await spendOverCap("s2")).toMatch(/daily/);
  });

  it("session cap blocks only the spendy session", async () => {
    process.env.MAX_SESSION_SPEND = "0.5";
    await recordSpend("hot", 0.6);
    expect(await spendOverCap("hot")).toMatch(/session/);
    expect(await spendOverCap("cold")).toBeNull();
  });

  it("estimateGenerationCost is positive and tier-monotonic", () => {
    const fast = estimateGenerationCost(body({ image_tier: "fast", mode: "query" }));
    const pro = estimateGenerationCost(body({ image_tier: "pro", mode: "query" }));
    expect(fast).toBeGreaterThan(0);
    expect(pro).toBeGreaterThan(fast);
  });
});
