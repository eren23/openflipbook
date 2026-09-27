import { expect, it, vi } from "vitest";
const { init } = vi.hoisted(() => ({ init: vi.fn(async () => {}) }));
vi.mock("@dimforge/rapier3d-compat", () => ({ default: { init } }));
it("shares WASM initialization across concurrent mounts and later view changes", async () => {
  vi.resetModules(); init.mockClear();
  const { loadPlacePhysics } = await import("./place-physics");
  const first = loadPlacePhysics(), second = loadPlacePhysics();
  expect(first).toBe(second);
  await first; await loadPlacePhysics(); expect(init).toHaveBeenCalledTimes(1);
});
it("allows retry after initialization fails", async () => {
  vi.resetModules(); init.mockClear(); init.mockRejectedValueOnce(new Error("WASM unavailable"));
  const { loadPlacePhysics } = await import("./place-physics");
  await expect(loadPlacePhysics()).rejects.toThrow("WASM unavailable");
  await expect(loadPlacePhysics()).resolves.toBeDefined(); expect(init).toHaveBeenCalledTimes(2);
});
