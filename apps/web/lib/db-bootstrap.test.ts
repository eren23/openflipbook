import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), createIndex: vi.fn() }));
vi.mock("mongodb", () => ({ MongoClient: vi.fn(function () {
  return { connect: mocks.connect, close: mocks.close, db: () => ({ collection: () => ({ createIndex: mocks.createIndex }) }) };
}) }));
vi.mock("./env", () => ({ readServerEnv: () => ({}), requireMongo: () => ({ uri: "mongodb://fixture", db: "fixture" }) }));
import { MongoClient } from "mongodb";
import { getDb } from "./db";
beforeEach(() => {
  globalThis.__endlessCanvasMongo = undefined; globalThis.__endlessCanvasMongoBootstrap = undefined;
  mocks.connect.mockReset().mockResolvedValue(undefined); mocks.close.mockReset().mockResolvedValue(undefined); mocks.createIndex.mockReset().mockResolvedValue("index");
  vi.mocked(MongoClient).mockClear();
});
afterEach(() => { globalThis.__endlessCanvasMongo = undefined; globalThis.__endlessCanvasMongoBootstrap = undefined; });
it.each(["connect", "createIndex"] as const)("closes a failed %s bootstrap and allows a later clean attempt", async stage => {
  const failure = new Error("Database setup refused"); mocks[stage].mockRejectedValueOnce(failure);
  await expect(getDb()).rejects.toBe(failure);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(globalThis.__endlessCanvasMongo).toBeUndefined(); expect(globalThis.__endlessCanvasMongoBootstrap).toBeUndefined();
  await getDb(); expect(MongoClient).toHaveBeenCalledTimes(2); expect(globalThis.__endlessCanvasMongo).toBeDefined();
});
it("shares one successful bootstrap across concurrent callers", async () => {
  const [a, b] = await Promise.all([getDb(), getDb()]);
  expect(a).toBe(b); expect(MongoClient).toHaveBeenCalledTimes(1); expect(mocks.connect).toHaveBeenCalledTimes(1); expect(mocks.close).not.toHaveBeenCalled();
});
