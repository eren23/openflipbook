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
  it("does not project world footprints onto an unknown uploaded image for exterior arrivals", async () => {
    await expect(resolvePlaceGeneration({ ...body(), arrival_intent: "exterior" })).rejects.toMatchObject({ status: 422 });
    mocks.map.mockResolvedValue({ entities: [{ ...place, entity_id: "entity" }], bounds: { x: 0, y: 0, w: 100, h: 60 } });
    mocks.state.mockResolvedValue({ entities: [{ id: "entity", appearance_bboxes: { root: { x_pct: .1, y_pct: .2, w_pct: .2, h_pct: .3 } } }] });
    const next = await resolvePlaceGeneration({ ...body(), arrival_intent: "exterior" });
    expect(next.place_reference?.provenance).toMatchObject({ kind: "source_bbox", node_id: "root" });
    expect(next.place_reference?.provenance?.image_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(next.scene_view?.place_form).toBe("generic");
    expect(next.scene_view?.view?.projection).toBe("eye_level");
  });
  it("known map scene arrivals default outside and preserve map projection provenance", async () => {
    mocks.node.mockResolvedValue({ _id: "root", scene_view: { level: "map" }, image_key: "owned.png" });
    const next = await resolvePlaceGeneration(body());
    expect(next.arrival_intent).toBe("exterior");
    expect(next.place_reference?.provenance?.kind).toBe("map_projection");
  });
  it("does not let a client aerial hint weaken the explicit exterior camera gate", async () => {
    mocks.node.mockResolvedValue({ _id: "root", scene_view: { level: "map" }, image_key: "owned.png" });
    const next = await resolvePlaceGeneration({ ...body(), arrival_intent: "exterior", scene_view: {
      node_id: "root", level: "map", observer: null, map_crop: null, focus_id: "tower", view: { projection: "top_down", source: "user" },
    } });
    expect(next.scene_view?.level).toBe("eye");
    expect(next.scene_view?.view).toEqual({ projection: "eye_level", source: "policy" });
  });
  it("prefers a valid first appearance, falls back after an invalid one, and never replaces a curated anchor", async () => {
    const box = { x_pct: .1, y_pct: .1, w_pct: .2, h_pct: .3 };
    mocks.map.mockResolvedValue({ entities: [{ ...place, entity_id: "entity" }], bounds: { x: 0, y: 0, w: 100, h: 60 } });
    mocks.node.mockImplementation(async (q: { _id: string }) => ({ _id: q._id, scene_view: { level: "map" }, image_key: `${q._id}.png` }));
    mocks.state.mockResolvedValue({ entities: [{ id: "entity", first_seen_node_id: "first", appearance_bboxes: { first: box, root: box } }] });
    expect((await resolvePlaceGeneration(body())).place_reference?.provenance).toMatchObject({ kind: "first_seen", node_id: "first" });
    mocks.state.mockResolvedValue({ entities: [{ id: "entity", first_seen_node_id: "first", appearance_bboxes: { first: { ...box, w_pct: 2 }, root: box } }] });
    expect((await resolvePlaceGeneration(body())).place_reference?.provenance?.kind).toBe("source_bbox");
    mocks.map.mockResolvedValue({ entities: [{ ...place, identity_anchor: { node_id: "curated", image_key: "immutable.png", bbox: box } }], bounds: { x: 0, y: 0, w: 100, h: 60 } });
    expect((await resolvePlaceGeneration(body())).place_reference?.provenance?.kind).toBe("curated");
    expect(mocks.bytes).toHaveBeenLastCalledWith("immutable.png");
    mocks.node.mockImplementation(async (q: { _id: string }) => q._id === "curated" ? null : { _id: q._id, image_key: "owned.png" });
    await expect(resolvePlaceGeneration(body())).rejects.toMatchObject({ status: 422 });
  });
  it("strips experimental intent outside strict scene generation and rejects invalid values", async () => {
    expect((await resolvePlaceGeneration({ ...body(), strict_world: false, arrival_intent: "exterior" })).arrival_intent).toBeUndefined();
    expect((await resolvePlaceGeneration({ ...body(), render_mode: "place_submap", arrival_intent: "exterior" })).arrival_intent).toBeUndefined();
    await expect(resolvePlaceGeneration({ ...body(), arrival_intent: "wrong" as never })).rejects.toMatchObject({ status: 400 });
  });
});
