// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Db } from "mongodb";
import type { ImageLedImage, ImageLedLandmark, ImageLedRepair, ImageLedWalkDoc } from "./image-led-walk";

const state = vi.hoisted(() => ({ current: vi.fn(), read: vi.fn(), mask: vi.fn(), owner: vi.fn(), transaction: vi.fn(), reserve: vi.fn(), receipt: null as unknown, walk: null as ImageLedWalkDoc | null }));
vi.mock("./r2", async () => ({ ...await vi.importActual<Record<string, unknown>>("./r2"), getStoredBytes: state.mask }));
vi.mock("./creator", async () => ({ ...await vi.importActual<Record<string, unknown>>("./creator"), requireCreator: state.owner }));
vi.mock("./db", () => ({ withDbTransaction: state.transaction }));
vi.mock("./generation-reservation", () => ({ reserveGenerationSpend: state.reserve }));
vi.mock("./image-led-walk-source", async () => ({ ...await vi.importActual<Record<string, unknown>>("./image-led-walk-source"), requireImageLedCurrent: state.current, readImageLedImage: state.read }));
import { imageLedAction, imageLedCapabilities, imageLedInputs, imageLedQuote, IMAGE_LED_MODEL, IMAGE_LED_PARAMETERS, IMAGE_LED_VIDEO_MODEL, IMAGE_LED_VIDEO_PARAMETERS } from "./image-led-walk-server";
import { imageLedBytesHash, imageLedHash, imageLedRoute } from "./image-led-walk-source";
import { IMAGE_LED_STILL_PROFILES } from "./image-led-walk-profiles";
import type { imageLedRouteIntent } from "./image-led-route-intent";
import { CreatorError } from "./creator-error";

const sourcePixels = [[940, 900], [1020, 815], [1060, 720], [1070, 630], [1050, 545], [1030, 465]] as const;
const points = sourcePixels.map(([x, y]) => ({ x: x / 2048, y: y / 1152 }));
function image(key: string, hash: string, width = 688, height = 384): ImageLedImage {
  return { key, sha256: hash.repeat(64), bytes: 128, width, height, content_type: "image/jpeg" };
}
function fixture(): ImageLedWalkDoc {
  const source = image("world/original-map.jpg", "a", 2048, 1152);
  const landmarks: ImageLedLandmark[] = [
    { id: "bookshop", label: "Bookshop", visual: "Rounded book-filled bay", source_rectangle: { left: 180, top: 520, width: 550, height: 350 } },
    { id: "inn", label: "Glassroot Inn", visual: "Copper moth sign and teal gables", source_rectangle: { left: 420, top: 160, width: 430, height: 390 } },
    { id: "forge", label: "Lantern Forge", visual: "Single open hearth and brick chimney", source_rectangle: { left: 1230, top: 590, width: 510, height: 390 } },
    { id: "conservatory", label: "Tideglass Conservatory", visual: "Faceted glass crown", source_rectangle: { left: 1230, top: 160, width: 500, height: 390 } },
  ].map((landmark, index) => ({ ...landmark, entity_id: landmark.id, reference_kind: "reviewed_source_crop", image: image(`world/crop-${landmark.id}.jpg`, String(index + 1), landmark.source_rectangle.width, landmark.source_rectangle.height) }));
  const walk: ImageLedWalkDoc = {
    _id: "world:route", id: "route", session_id: "world", profile: "image-led-v1", created_at: new Date(0), updated_at: new Date(0), request_sha256: "b".repeat(64), status: "active", revision: 1,
    source: { node_id: "map", image_key: source.key, image: source, map_frame: { bounds: { x: 0, y: 0, w: 100, h: 100 }, parent_id: null }, source_projection: "illustrated_oblique_or_unknown", binding_sha256: "c".repeat(64) },
    landmarks, route: imageLedRoute(points, source.sha256), prompt: "Keep the original buildings and follow the curved lane",
    frames: points.map((_, index) => ({ index, status: "empty", review: { identity: "pending", route: "pending", spatial: "unmeasured" } })),
    legs: points.slice(1).map((_, index) => ({ index, from: index, to: index + 1, status: "empty", review: { temporal: "pending" } })),
  };
  approve(walk, 0, image("world/B07-reviewed.jpg", "d"));
  approve(walk, 1, image("world/immediately-previous-reviewed.jpg", "e"));
  return walk;
}
function approve(walk: ImageLedWalkDoc, index: number, file = image(`world/frame-${index}.jpg`, (index + 5).toString(16))) {
  walk.frames[index] = { index, status: "ready", raw: file, image: file, review: { identity: "approved", route: "approved", spatial: "unmeasured", sha256: file.sha256, reviewed_at: new Date(0).toISOString() } };
}
const db = { collection: (name: string) => ({ findOne: async (query: Record<string, unknown>) => {
  if (name === "image_led_walks") return state.walk;
  if (name === "image_led_walk_steps") return state.receipt;
  if (name === "generation_workers" && (query.image_led_walk_v4_canvas_v1 === true || query.image_led_walk_video_v4 === true)) return { _id: "compatible-worker" };
  return null;
} }) } as unknown as Db;
const capability = (kind: "still" | "video") => ({ model: kind === "still" ? IMAGE_LED_MODEL : IMAGE_LED_VIDEO_MODEL, parameters: kind === "still" ? IMAGE_LED_PARAMETERS : IMAGE_LED_VIDEO_PARAMETERS, reservation: kind === "still" ? .15 : .24 });
type InputsBody = { route_intent: ReturnType<typeof imageLedRouteIntent>; landmarks: { id: string; image?: { sha256: string } }[]; prior?: { checkpoint_index: number; reviewed_sha256: string; image: { sha256: string; url: string } }; start?: { sha256: string }; end?: { sha256: string } };

beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  state.walk = fixture(); state.owner.mockResolvedValue(db); state.current.mockResolvedValue({ source: state.walk.source });
  state.receipt = null;
  state.read.mockImplementation(async (key: string, expected: ImageLedImage) => ({ image: expected, bytes: Buffer.alloc(expected.bytes), url: `data:${expected.content_type};base64,${Buffer.from(key).toString("base64")}` }));
  state.transaction.mockRejectedValue(new Error("No transaction should start for a stale quote"));
  vi.stubEnv("MODAL_API_URL", "http://fixture.invalid"); vi.stubEnv("PATH_VIDEO_ENABLED", "1");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { const kind = url.includes("/video/") ? "video" : "still"; return new Response(JSON.stringify({ enabled: true, profile: "image-led-v1", ...capability(kind) })); }));
});

it("sends all four original crop identities and the immediately preceding reviewed image, not global B07", async () => {
  const walk = state.walk!, before = structuredClone(walk);
  const inputs = await imageLedInputs(db, walk, "still", 2, capability("still")), body = inputs.body as unknown as InputsBody;
  expect(body.landmarks.map(landmark => landmark.id)).toEqual(["bookshop", "inn", "forge", "conservatory"]);
  expect(body.landmarks.map(landmark => landmark.image!.sha256)).toEqual(walk.landmarks.map(landmark => landmark.image.sha256));
  expect(body.prior).toMatchObject({ checkpoint_index: 1, reviewed_sha256: "e".repeat(64), image: { sha256: "e".repeat(64) } });
  expect(body.prior!.image.sha256).not.toBe(walk.frames[0]!.image!.sha256);
  expect(state.read.mock.calls.at(-1)![0]).toBe("world/immediately-previous-reviewed.jpg");
  expect(walk).toEqual(before); expect(fetch).not.toHaveBeenCalled();
});

it("communicates the curved source-pixel route and estimated landmark bearings without inventing a camera", async () => {
  const { body } = await imageLedInputs(db, state.walk!, "still", 2, capability("still"));
  const intent = (body as unknown as InputsBody).route_intent;
  expect(intent).toMatchObject({ version: 1, basis: "source-image-pixels", registration: "estimated", source_sha256: "a".repeat(64), map_dimensions: { width: 2048, height: 1152 }, checkpoint_index: 2 });
  const headings = [43.264295, 22.833654, 6.340192, 346.759480, 345.963757];
  headings.forEach((heading, index) => expect(intent.checkpoints[index]!.heading_degrees).toBeCloseTo(heading, 4));
  expect(intent.checkpoints.slice(1, 4).every(checkpoint => checkpoint.turn === "left")).toBe(true);
  expect(intent.checkpoints[2]!.landmark_relations.map(landmark => landmark.id)).toEqual(["bookshop", "inn", "forge", "conservatory"]);
  expect(intent).not.toHaveProperty("camera"); expect(intent).not.toHaveProperty("metres");
});

it("explicitly binds the same transmitted intent into the input fingerprint used by quotes and paid claims", async () => {
  const walk = state.walk!, cap = capability("still"), { body, sha256 } = await imageLedInputs(db, walk, "still", 2, cap);
  const fingerprint = { source: walk.source, landmarks: walk.landmarks, route: walk.route, route_intent: body.route_intent, prompt: walk.prompt, seed: null, kind: "still", index: 2, parent: walk.frames[1], ...cap, playback: { kind: "contain-jpeg-v1", width: 688, height: 384, background: "#20231e" } };
  expect(sha256).toBe(imageLedHash(fingerprint));
  const { route_intent: _intent, ...withoutIntent } = fingerprint;
  expect(sha256).not.toBe(imageLedHash(withoutIntent));
});

it("passes the source-relative turn and neighborhood plan to video with only the exact reviewed adjacent endpoints", async () => {
  const walk = state.walk!; walk.frames.forEach((_, index) => { if (index > 1) approve(walk, index); });
  const inputs = await imageLedInputs(db, walk, "video", 0, capability("video")), body = inputs.body as unknown as InputsBody;
  expect(body.start!.sha256).toBe(walk.frames[0]!.image!.sha256); expect(body.end!.sha256).toBe(walk.frames[1]!.image!.sha256);
  expect(body.route_intent.checkpoint_index).toBe(0); expect(body.route_intent.checkpoints[1]!.turn).toBe("left");
  expect(body.landmarks.map(landmark => landmark.id)).toEqual(walk.landmarks.map(landmark => landmark.id));
  expect(walk.legs.every(leg => leg.review.temporal === "pending")).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled();
});

it.each(["still", "video"] as const)("rejects stale v1 %s capabilities before inputs or spending", async kind => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, profile: "image-led-v1", ...capability(kind), parameters: { ...capability(kind).parameters, prompt_version: kind === "still" ? "image-led-walk-v1" : "image-led-walk-video-v1" } }))));
  await expect(imageLedCapabilities(db, kind)).rejects.toMatchObject({ status: 503 });
  expect(state.read).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
});

it("rejects v2 still capabilities before a v4 quote can reserve or upload", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, profile: "image-led-v1", ...capability("still"), parameters: { ...IMAGE_LED_PARAMETERS, prompt_version: "image-led-walk-v2" } }))));
  await expect(imageLedCapabilities(db, "still")).rejects.toMatchObject({ status: 503 });
  expect(state.read).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
});

it("quotes only the closed disabled-expansion video v4 profile with a compatible worker", async () => {
  await expect(imageLedCapabilities(db, "video")).resolves.toEqual({ model: "minimax/h3-max/image-to-video", reservation: .24, parameters: { duration: 3, resolution: "768P", prompt_expansion_mode: "disabled", enable_safety_checker: true, sync_mode: false, prompt_version: "image-led-walk-video-v4" } });
  expect(state.read).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled();
});

it.each([
  { prompt_expansion_mode: "balanced" },
  { prompt_expansion_mode: "quality" },
  { prompt_version: "image-led-walk-video-v2" },
  { prompt_version: "image-led-walk-video-v2", prompt_expansion_mode: "balanced" },
])("rejects stale or rewritten video capabilities %j before reading inputs or spending", async changes => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, profile: "image-led-v1", ...capability("video"), parameters: { ...IMAGE_LED_VIDEO_PARAMETERS, ...changes } }))));
  await expect(imageLedCapabilities(db, "video")).rejects.toMatchObject({ status: 503 });
  expect(state.read).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
});

it("rejects a consented balanced v2 video quote rather than upgrading it to v3", async () => {
  state.walk!.frames.forEach((_, index) => approve(state.walk!, index));
  const quote = await imageLedQuote(db, state.walk!, "video", 0), stale = { ...quote, parameters: { ...quote.parameters, prompt_expansion_mode: "balanced", prompt_version: "image-led-walk-video-v2" } };
  const { quote_sha256: _oldHash, ...unsigned } = stale; stale.quote_sha256 = imageLedHash(unsigned);
  await expect(imageLedAction("world", "route", { action: "schedule", id: "11111111-1111-4111-8111-111111111111", kind: "video", index: 0, quote: stale, confirmed: true })).rejects.toMatchObject({ status: 409 });
  expect(state.reserve).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
});

it.each(["still", "video"] as const)("blocks new %s quotes while a fresh worker only understands older prompts", async kind => {
  const flag = kind === "still" ? "image_led_walk_v4_canvas_v1" : "image_led_walk_video_v4";
  const find = vi.fn<(query: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue({ _id: "old-worker", image_led_walk_v1: true, image_led_walk_v2: true, image_led_walk_video_v1: true, image_led_walk_video_v2: true });
  const legacyDb = { collection: () => ({ findOne: find }) } as unknown as Db;
  await expect(imageLedCapabilities(legacyDb, kind)).rejects.toMatchObject({ status: 503 });
  expect(find.mock.calls[0]![0]).toMatchObject({ [flag]: { $ne: true }, [kind === "still" ? "mesh" : "motion"]: true });
  expect(state.read).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled();
});

it.each(["image-led-walk-v1", "image-led-walk-v2", "image-led-walk-v3"])("refuses a consented %s quote under v4 even if its old quote hash is reconstructed", async version => {
  const quote = await imageLedQuote(db, state.walk!, "still", 2), stale = { ...quote, parameters: { ...quote.parameters, prompt_version: version } };
  const { quote_sha256: _oldHash, ...unsigned } = stale; stale.quote_sha256 = imageLedHash(unsigned);
  await expect(imageLedAction("world", "route", { action: "schedule", id: "11111111-1111-4111-8111-111111111111", kind: "still", index: 2, quote: stale, confirmed: true })).rejects.toMatchObject({ status: 409 });
  expect(state.reserve).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
});

it("cannot substitute intent or B07 for a rejected immediately preceding route view", async () => {
  state.walk!.frames[1]!.review.route = "rejected";
  await expect(imageLedInputs(db, state.walk!, "still", 2, capability("still"))).rejects.toThrow("Review each preceding artwork");
  expect(state.current).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
});

it("fails stale source binding before assembling route intent or reading any candidate references", async () => {
  state.current.mockRejectedValueOnce(new CreatorError("Original map changed", 409));
  await expect(imageLedInputs(db, state.walk!, "still", 2, capability("still"))).rejects.toMatchObject({ status: 409 });
  expect(state.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it.each(Object.keys(IMAGE_LED_STILL_PROFILES))("accepts the current allowlisted %s profile only with a v4 worker", async model => {
  const profile = IMAGE_LED_STILL_PROFILES[model as keyof typeof IMAGE_LED_STILL_PROFILES];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, profile: "image-led-v1", model, parameters: profile.parameters, reservation: .15 }))));
  await expect(imageLedCapabilities(db, "still")).resolves.toEqual({ model, parameters: profile.parameters, reservation: .15 });
  expect(state.reserve).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
});
it("rejects an arbitrary capability endpoint before reading source bytes or reserving spend", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, profile: "image-led-v1", model: "https://foreign.test/edit", parameters: IMAGE_LED_PARAMETERS, reservation: .15 }))));
  await expect(imageLedCapabilities(db, "still")).rejects.toMatchObject({ status: 503 });
  expect(state.read).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled();
});
it("binds owned exact repair target and transparent PNG mask into the quote and immutable inputs", async () => {
  const walk = state.walk!, target = image("world/image-led/old/original.png", "f", 512, 288), bytes = await sharp({ create: { width: 512, height: 288, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
  target.content_type = "image/png";
  const mask: ImageLedImage = { ...target, key: "world/image-led/old/mask.png", sha256: imageLedBytesHash(bytes), bytes: bytes.length };
  const repair: ImageLedRepair = { checkpoint_index: 2, source_sha256: walk.source.image.sha256, target_sha256: target.sha256, image: target, mask };
  state.receipt = { _id: "old" }; state.mask.mockResolvedValue({ bytes });
  const model = "openai/gpt-image-2.5/sunburst/edit", cap = { model, parameters: IMAGE_LED_STILL_PROFILES[model].parameters, reservation: .15 };
  const original = await imageLedInputs(db, walk, "still", 2, cap, repair);
  expect(original.body).toMatchObject({ repair: { checkpoint_index: 2, source_sha256: walk.source.image.sha256, target_sha256: target.sha256, image: { sha256: target.sha256 }, mask: { sha256: mask.sha256, url: `data:image/png;base64,${bytes.toString("base64")}` } }, prior: { reviewed_sha256: walk.frames[1]!.image!.sha256 } });
  expect((original.body.repair as Record<string, unknown>).image).not.toHaveProperty("key");
  const changedBytes = await sharp({ create: { width: 512, height: 288, channels: 3, background: "black" } }).png().toBuffer(), changedMask = { ...mask, sha256: imageLedBytesHash(changedBytes), bytes: changedBytes.length };
  state.mask.mockResolvedValue({ bytes: changedBytes });
  expect((await imageLedInputs(db, walk, "still", 2, cap, { ...repair, mask: changedMask })).sha256).not.toBe(original.sha256);
  state.mask.mockResolvedValue({ bytes });
  await expect(imageLedInputs(db, walk, "still", 2, cap, { ...repair, mask: changedMask })).rejects.toMatchObject({ status: 409 });
  expect(state.reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("exposes an owned repair quote through the free action while retaining the exact predecessor", async () => {
  const walk = state.walk!, before = structuredClone(walk), target = image("world/image-led/old/original.png", "f", 512, 288);
  const repair: ImageLedRepair = { checkpoint_index: 2, source_sha256: walk.source.image.sha256, target_sha256: target.sha256, image: target };
  state.receipt = { _id: "old" };
  const detail = await imageLedAction("world", "route", { action: "quote", kind: "still", index: 2, repair });
  expect(detail).toMatchObject({ quote: { repair, inputs_sha256: expect.any(String), index: 2 } });
  expect(state.read.mock.calls.map(([key]) => key)).toContain(walk.frames[1]!.image!.key);
  expect(state.read.mock.calls.map(([key]) => key)).toContain(target.key);
  expect(walk).toEqual(before); expect(state.reserve).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});
it("rejects unreceipted or foreign repair provenance and unsupported masks without spending", async () => {
  const walk = state.walk!, target = image("world/image-led/old/original.png", "f", 512, 288), repair: ImageLedRepair = { checkpoint_index: 2, source_sha256: walk.source.image.sha256, target_sha256: target.sha256, image: target };
  await expect(imageLedInputs(db, walk, "still", 2, capability("still"), repair)).rejects.toThrow("saved receipt");
  expect(state.read).not.toHaveBeenCalled();
  await expect(imageLedInputs(db, walk, "still", 2, capability("still"), { ...repair, image: { ...target, key: "foreign/image-led/raw.png" } })).rejects.toMatchObject({ status: 400 });
  await expect(imageLedInputs(db, walk, "still", 2, capability("still"), { ...repair, mask: { ...target, content_type: "image/png" } })).rejects.toThrow("does not support repair masks");
  expect(state.mask).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled();
});
it("binds the exact starting canvas into a still quote and invalidates it when the canvas changes", async () => {
  const before = await imageLedQuote(db, state.walk!, "still", 2);
  expect(before).toMatchObject({ playback: { kind: "contain-jpeg-v1", width: 688, height: 384, background: "#20231e" } });
  state.walk!.frames[0]!.image!.height = 387;
  const after = await imageLedQuote(db, state.walk!, "still", 2);
  expect(after.inputs_sha256).not.toBe(before.inputs_sha256); expect(after.quote_sha256).not.toBe(before.quote_sha256);
  expect(fetch).toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled(); expect(state.transaction).not.toHaveBeenCalled();
});
