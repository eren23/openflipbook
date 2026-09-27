import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ metadata: null as { visibility: string } | null, requireCreator: vi.fn() }));
vi.mock("./db", () => ({ getDb: async () => ({ collection: () => ({ findOne: async () => state.metadata }) }) }));
vi.mock("./creator", () => ({ requireCreator: state.requireCreator }));
import { requireWorldRead } from "./world-access";
beforeEach(() => { state.metadata = null; state.requireCreator.mockReset(); });
it("preserves legacy unlisted reads without claiming ownership", async () => {
  await requireWorldRead("legacy"); expect(state.requireCreator).not.toHaveBeenCalled();
});
it("requires ownership for private worlds and propagates denial", async () => {
  state.metadata = { visibility: "private" };
  await requireWorldRead("world"); expect(state.requireCreator).toHaveBeenCalledWith("world");
  state.requireCreator.mockRejectedValue(Object.assign(new Error("Not owner"), { status: 403 }));
  await expect(requireWorldRead("world")).rejects.toMatchObject({ status: 403 });
});
