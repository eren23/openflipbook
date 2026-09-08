import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNode: vi.fn(),
  insertNode: vi.fn(),
  deleteNode: vi.fn(),
  updateNodeParent: vi.fn(),
  recordError: vi.fn(),
  requireOwner: vi.fn(),
  uploadJpeg: vi.fn(),
  decodeDataUrl: vi.fn(),
  getIdempotentResult: vi.fn(),
  saveIdempotentResult: vi.fn(),
  getWorldMap: vi.fn(),
  upsertEntityGeos: vi.fn(),
  removeEntityGeos: vi.fn(),
}));

vi.mock("@/lib/db", () => mocks);
vi.mock("@/lib/r2", () => mocks);
vi.mock("@/lib/session-owner", () => mocks);
vi.mock("@/lib/idempotency", () => mocks);
vi.mock("@/lib/world-map", () => mocks);
vi.mock("@/lib/env", () => ({
  readServerEnv: () => ({ MONGODB_URI: "mongodb://test", MONGODB_DB: "test", R2_BUCKET: "test" }),
}));
vi.mock("@/lib/env-flag", () => ({ envFlag: () => true }));

import { POST as createNode } from "@/app/api/nodes/route";
import { POST as ascend } from "@/app/api/world/[sessionId]/ascend/route";

const child = { id: "child", parent_id: null, session_id: "s1", scale_tier: "city", aspect_ratio: "16:9" };
const createBody = { session_id: "s1", page_title: "Town", image_data_url: "data:image/jpeg;base64,YQ==" };
const ascendBody = { child_node_id: "child", page_title: "Region", image_data_url: createBody.image_data_url, parent_tier: "region" };
const params = { params: Promise.resolve({ sessionId: "s1" }) };

function request(body: unknown, key?: string) {
  return new Request("http://localhost/api/nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireOwner.mockResolvedValue({ ok: true });
  mocks.getNode.mockResolvedValue(child);
  mocks.insertNode.mockResolvedValue({ id: "saved", created_at: "2026-09-05" });
  mocks.decodeDataUrl.mockReturnValue({ bytes: Buffer.from("a"), contentType: "image/jpeg" });
  mocks.uploadJpeg.mockResolvedValue({ key: "image.jpg", url: "https://images.test/image.jpg" });
  mocks.getIdempotentResult.mockResolvedValue(null);
  mocks.saveIdempotentResult.mockResolvedValue(undefined);
  mocks.getWorldMap.mockResolvedValue({ entities: [] });
  mocks.updateNodeParent.mockResolvedValue(true);
  mocks.deleteNode.mockResolvedValue(true);
});

describe("node write session boundaries", () => {
  it('persists server-bound transition context and returns it to fresh page state', async () => {
    mocks.getNode.mockResolvedValue({ ...child, image_key: 'original.png', scene_view: null });
    const res = await createNode(request({ ...createBody, parent_id: 'child', click_in_parent: { x_pct: .8, y_pct: .3 } }));
    expect(res.status).toBe(200);
    expect((await res.json()).transition_context).toMatchObject({ source_node_id: 'child', source_image_key: 'original.png', source_view: null, target_point: { x_pct: .8, y_pct: .3 } });
    expect(mocks.insertNode).toHaveBeenCalledWith(expect.objectContaining({ transition_context: expect.objectContaining({ version: 1 }) }));
  });
  it('refuses forged transition identity before upload', async () => {
    const res = await createNode(request({ ...createBody, parent_id: 'child', transition_context: { version: 1, source_node_id: 'other' } }));
    expect(res.status).toBe(400);
    expect(mocks.uploadJpeg).not.toHaveBeenCalled();
  });
  it("refuses to reparent a root from another session before any writes", async () => {
    mocks.getNode.mockResolvedValue({ ...child, session_id: "other" });
    const res = await ascend(request(ascendBody), params);
    expect(res.status).toBe(404);
    expect(mocks.uploadJpeg).not.toHaveBeenCalled();
    expect(mocks.updateNodeParent).not.toHaveBeenCalled();
    expect(mocks.upsertEntityGeos).not.toHaveBeenCalled();
  });

  it("refuses to insert a child under another session's node", async () => {
    mocks.getNode.mockResolvedValue({ ...child, session_id: "other" });
    const res = await createNode(request({ ...createBody, parent_id: "child" }));
    expect(res.status).toBe(404);
    expect(mocks.uploadJpeg).not.toHaveBeenCalled();
    expect(mocks.insertNode).not.toHaveBeenCalled();
  });

  it("allows a child whose parent belongs to the same session", async () => {
    const res = await createNode(request({ ...createBody, parent_id: "child" }));
    expect(res.status).toBe(200);
    expect(mocks.insertNode).toHaveBeenCalledWith(expect.objectContaining({ parent_id: "child", session_id: "s1" }));
  });

  it("does not reuse another session's node-save retry result", async () => {
    const cache = new Map<string, unknown>();
    mocks.getIdempotentResult.mockImplementation(async (key: string) => cache.get(key) ?? null);
    mocks.saveIdempotentResult.mockImplementation(async (key: string, value: unknown) => { cache.set(key, value); });
    mocks.insertNode.mockResolvedValueOnce({ id: "first", created_at: "today" });
    mocks.insertNode.mockResolvedValueOnce({ id: "second", created_at: "today" });
    await createNode(request(createBody, "retry-1"));
    const second = await createNode(request({ ...createBody, session_id: "s2" }, "retry-1"));
    expect((await second.json()).id).toBe("second");
    const replay = await createNode(request(createBody, "retry-1"));
    expect((await replay.json()).id).toBe("first");
    expect(mocks.insertNode).toHaveBeenCalledTimes(2);
  });

  it("checks ownership before reading cached save results", async () => {
    mocks.requireOwner.mockResolvedValue({ ok: false, res: new Response(null, { status: 403 }) });
    const res = await createNode(request(createBody, "retry-1"));
    expect(res.status).toBe(403);
    expect(mocks.getIdempotentResult).not.toHaveBeenCalled();
  });

  it.each([null, [], { ...ascendBody, child_node_id: { $ne: null } }])("rejects malformed ascend body %j", async (body) => {
    expect((await ascend(request(body), params)).status).toBe(400);
    expect(mocks.getNode).not.toHaveBeenCalled();
  });

  it.each([null, [], { ...createBody, session_id: { $ne: null } }])("rejects malformed node body %j", async (body) => {
    expect((await createNode(request(body))).status).toBe(400);
    expect(mocks.insertNode).not.toHaveBeenCalled();
  });
});

describe("OUTWARD tier boundary", () => {
  it.each(["building", "city", "invalid", "toString"])("rejects non-coarser tier %s", async (parent_tier) => {
    expect((await ascend(request({ ...ascendBody, parent_tier }), params)).status).toBe(400);
    expect(mocks.insertNode).not.toHaveBeenCalled();
  });

  it("validates uploaded roots with the backend's city fallback", async () => {
    mocks.getNode.mockResolvedValue({ ...child, scale_tier: null, scene_view: null });
    expect((await ascend(request({ ...ascendBody, parent_tier: "building" }), params)).status).toBe(400);
  });

  it("persists a valid wider container", async () => {
    expect((await ascend(request(ascendBody), params)).status).toBe(200);
    expect(mocks.updateNodeParent).toHaveBeenCalledWith("child", expect.any(String));
  });
});
