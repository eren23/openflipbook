// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { Db, MongoClient } from "mongodb";

const state = vi.hoisted(() => ({ next: vi.fn(), heartbeat: vi.fn(), remove: vi.fn(), close: vi.fn(), events: [] as string[] }));
vi.mock("../lib/db", () => ({ getDb: async () => ({ collection: () => ({ updateOne: state.heartbeat, deleteOne: state.remove }) }) }));
vi.mock("../lib/place-build-execution", () => ({ processNextPlaceBuild: state.next }));
vi.mock("../lib/scene-text-edit-server", () => ({ processNextSceneEdit: state.next }));
vi.mock("../lib/mesh-execution", () => ({ processNextMeshJob: vi.fn(), processNextAssetJob: vi.fn() }));
vi.mock("../lib/motion-execution", () => ({ processNextMotionJob: vi.fn() }));
vi.mock("../lib/path-video", () => ({ processNextPathVideo: vi.fn() }));
vi.mock("../lib/image-led-walk-execution", () => ({ processNextImageLedWalk: vi.fn() }));
vi.mock("../lib/motion-video", () => ({ motionVideoToolsAvailable: async () => false }));
vi.mock("../lib/env", () => ({ readServerEnv: () => ({}), requireR2: () => { throw new Error("No fixture storage"); } }));

afterEach(() => {
  globalThis.__endlessCanvasMongo = undefined;
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
it("SIGTERM drains in-flight lanes and heartbeat before removing presence, closing Mongo and exiting", async () => {
  vi.useFakeTimers();
  vi.stubEnv("MODAL_API_URL", "http://fixture.invalid"); vi.stubEnv("SHARED_TOKEN", "fixture-only");
  vi.spyOn(process.stdout, "write").mockReturnValue(true); vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  let finishWork!: (value: boolean) => void, finishHeartbeat!: () => void;
  const work = new Promise<boolean>(resolve => { finishWork = resolve; });
  const heartbeat = new Promise<void>(resolve => { finishHeartbeat = resolve; });
  state.next.mockReset().mockImplementation(() => work);
  state.heartbeat.mockReset().mockResolvedValueOnce(undefined).mockImplementation(() => heartbeat);
  state.remove.mockReset().mockImplementation(async () => { state.events.push("presence removed"); });
  state.close.mockReset().mockImplementation(async () => { state.events.push("Mongo closed"); });
  state.events = [];
  globalThis.__endlessCanvasMongo = { client: { close: state.close } as unknown as MongoClient, db: {} as Db };
  const run = import("../scripts/place-build-worker");
  await vi.waitFor(() => expect(state.next).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(5000);
  expect(state.heartbeat).toHaveBeenCalledTimes(2);
  process.emit("SIGTERM");
  expect(exit).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
  finishWork(false); await vi.advanceTimersByTimeAsync(0);
  expect(exit).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
  finishHeartbeat(); await run;
  expect(state.events).toEqual(["presence removed", "Mongo closed"]);
  expect(exit).toHaveBeenCalledWith(0);
  expect(state.next).toHaveBeenCalledTimes(2);
});
