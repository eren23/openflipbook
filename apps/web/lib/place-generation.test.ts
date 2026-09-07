import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateRequestBody, WorldEntityGeo } from "@openflipbook/config";

const mocks = vi.hoisted(() => ({ node: vi.fn(), map: vi.fn(), state: vi.fn(), bytes: vi.fn() }));
vi.mock("./db", () => ({ getDb: async () => ({ collection: () => ({ findOne: mocks.node }) }) }));
vi.mock("./world-map", () => ({ getWorldMap: mocks.map }));
vi.mock("./world", () => ({ getWorldState: mocks.state }));
vi.mock("./r2", () => ({ getStoredBytes: mocks.bytes }));
import { resolvePlaceGeneration } from "./place-generation";

const place: WorldEntityGeo = { id: "tower", entity_id: null, kind: "place", label: "Canonical Tower", visual: "red roof", pos: { x: 50, y: 30 }, footprint: { w: 10, d: 10 }, height: 8, state: {}, confidence: 1, source: "user", updated_at: "2026-09-06T00:00:00.000Z" };
const body = (): GenerateRequestBody => ({ query: "context", session_id: "world", current_node_id: "root", mode: "tap", world_mode: true, strict_world: true, target_geo_id: "tower", image: "spoofed", aspect_ratio: "16:9", web_search: false, render_mode: "place_scene" });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("WORLD_IDENTITY_STRICT", "true");
  mocks.node.mockResolvedValue({ _id: "root", session_id: "world", scene_view: null, image_key: "owned.png" });
  mocks.map.mockResolvedValue({ entities: [place], bounds: { x: 0, y: 0, w: 100, h: 60 } });
  mocks.state.mockResolvedValue({ entities: [] });
  mocks.bytes.mockResolvedValue({ bytes: Buffer.from("owned"), contentType: "image/png" });
});

describe("server-resolved identity context", () => {
  it("replaces client references, labels and source bytes from persisted data", async () => {
    const next = await resolvePlaceGeneration({ ...body(), prefetched_subject: "Another tower", condition_image_urls: ["foreign"], condition_roles: ["style"], max_attempts: 4 });
    expect(next.prefetched_subject).toBe(place.label);
    expect(next.image).toBe("data:image/png;base64,b3duZWQ=");
    expect(next.condition_image_urls).toBeUndefined();
    expect(next.place_reference?.geo_id).toBe(place.id);
    expect(next.max_attempts).toBe(2); expect(next.verify).toBe(true);
  });
  it("rejects unknown targets and source nodes outside the session", async () => {
    await expect(resolvePlaceGeneration({ ...body(), target_geo_id: "foreign" })).rejects.toMatchObject({ status: 404 });
    mocks.node.mockResolvedValue(null);
    await expect(resolvePlaceGeneration(body())).rejects.toMatchObject({ status: 404 });
    expect(mocks.node).toHaveBeenCalledWith({ _id: "root", session_id: "world" });
  });
  it("does not silently fall back when strict mode is disabled", async () => {
    vi.stubEnv("WORLD_IDENTITY_STRICT", "false");
    await expect(resolvePlaceGeneration(body())).rejects.toMatchObject({ status: 409 });
  });
  it("keeps legacy requests unchanged, stripping untrusted canonical-reference bytes", async () => {
    const legacy: GenerateRequestBody = { ...body(), strict_world: false };
    delete legacy.target_geo_id;
    const next = await resolvePlaceGeneration(legacy as GenerateRequestBody);
    expect(next.image).toBe("spoofed"); expect(mocks.node).not.toHaveBeenCalled();
  });
  it("honors a smaller attempt limit", async () => expect((await resolvePlaceGeneration({ ...body(), max_attempts: 1 })).max_attempts).toBe(1));
  it("resolves OUTWARD from the saved root, even for uploads with null scene_view", async () => {
    const next = await resolvePlaceGeneration({ ...body(), mode: "ascend" });
    expect(next.image).not.toBe("spoofed"); expect(next.scene_view).toBeUndefined();
  });
  it("recomputes closeup extent instead of trusting client geometry", async () => {
    const next = await resolvePlaceGeneration({ ...body(), render_mode: "place_submap", scene_view: { node_id: "foreign", level: "map", observer: null, focus_id: "foreign", map_crop: { x: -999, y: 0, w: 1, h: 1 } } });
    expect(next.scene_view?.map_crop).toEqual({ x: 45, y: 25, w: 10, h: 10 });
    expect(next.scene_view?.focus_id).toBe("tower");
  });
  it("requires an explicit reference when a perspective view has no registered appearance", async () => {
    mocks.node.mockResolvedValue({ _id: "root", session_id: "world", scene_view: { level: "building" }, image_key: "owned.png" });
    await expect(resolvePlaceGeneration(body())).rejects.toMatchObject({ status: 422 });
  });
});
