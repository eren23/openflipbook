import { beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { orbitPose } from "./camera-path";
import sharp from "sharp";
import type { PlaceConnection, PlaceSceneSnapshot } from "@openflipbook/config";
import type * as CreatorModule from "./creator";

const memory = vi.hoisted(() => ({ rows: new Map<string, Map<string, Document>>(), files: new Map<string, Buffer>(), owner: true, uploads: 0, onUpload: (() => {}) as () => void, tail: Promise.resolve() }));
const store = (name: string) => { if (!memory.rows.has(name)) memory.rows.set(name, new Map()); return memory.rows.get(name)!; };
function collection(name: string) {
  const find = (query: Document) => [...store(name).values()].filter(row => Object.entries(query).every(([k, v]) => v && typeof v === "object" && "$in" in v ? v.$in.includes(row[k]) : row[k] === v));
  return {
    findOne: async (q: Document) => structuredClone(find(q)[0] ?? null),
    countDocuments: async (q: Document) => find(q).length,
    find: (q: Document) => { const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => structuredClone(find(q)) }; return cursor; },
    insertOne: async (row: Document) => { if (store(name).has(row._id)) throw new Error("Duplicate"); store(name).set(row._id, structuredClone(row)); },
    updateOne: async (q: Document, change: Document) => { const row = find(q)[0]; if (row) for (const [k, v] of Object.entries(change.$inc ?? {})) row[k] = (row[k] ?? 0) + Number(v); return { matchedCount: row ? 1 : 0 }; },
  };
}
vi.mock("./db", () => ({ withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>) => {
  const previous = memory.tail; let release!: () => void; memory.tail = new Promise<void>(r => { release = r; }); await previous;
  const before = structuredClone(memory.rows);
  try { return await run({ collection } as unknown as Db, {} as ClientSession); } catch (e) { memory.rows = before; throw e; } finally { release(); }
} }));
vi.mock("./creator", async original => {
  const creator = await original<typeof CreatorModule>();
  return { ...creator, requireCreator: async () => { if (!memory.owner) throw new creator.CreatorError("Not owner", 403); return { collection }; } };
});
vi.mock("./place-scene-enabled", () => ({ placeScenesEnabled: () => true }));
vi.mock("./r2", () => ({ uploadJpeg: async (key: string, bytes: Buffer) => { memory.uploads++; memory.files.set(key, bytes); memory.onUpload(); }, getStoredBytes: async (key: string) => memory.files.has(key) ? { bytes: memory.files.get(key)! } : null }));
import { emptyPlaceScene, newComponent, sceneGeos } from "./place-scene";
import { adjacentPlacement, networkView, placeNetwork } from "./place-connections";
import { downloadPlaceViewExports, snapshotPlaceViewExports, exportPlaceViews, parseCaptureMetadata, placeViewBytes, placeViewLibrary, savePlaceView, type PlaceViewDoc } from "./place-view-server";
import { buildWorldZip } from "./export-build";
import { readWorldArchive } from "./world-import-archive";
import { prepareWorldImport } from "./world-import-content";
import { illustrationDependency } from "./illustration-input";
import { cameraMotionPreview } from "./camera-motion-server";
import { motionStudyLibrary, motionStudyFrame, saveMotionStudy } from "./motion-study-server";
import { currentMotionStudy, motionSourceImage } from "./motion-source";
import { viewHash } from "./place-view-store";
import type { MotionStudyDoc } from "./motion-study";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { objectMaskColor, VIEW_PASSES, type ViewCapture } from "./place-view";

function savedScene(id = "place"): PlaceSceneSnapshot {
  return { id: `scene_${id}`, place_id: id, session_id: "world", revision: 1, source_node_id: null, source_image_key: null, updated_at: new Date(0).toISOString(),
    definition: { ...emptyPlaceScene(), width: 20, depth: 20, objects: [{ ...newComponent("building", 5, 5), id: `building_${id}`, width: 4, depth: 4 }] } };
}
const root = () => store("place_scenes").get("world:place")!;
async function capture(mode: ViewCapture["mode"] = "orbit"): Promise<ViewCapture> {
  const camera = mode === "plan" ? new OrthographicCamera(-10, 10, 10, -10, 0.1, 100) : new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(10, 15, 25); camera.lookAt(10, 0, 10); camera.updateMatrixWorld(true);
  const png = `data:image/png;base64,${(await sharp({ create: { width: 32, height: 32, channels: 4, background: "#5473aa" } }).png().toBuffer()).toString("base64")}`;
  return { version: 1, mode, width: 32, height: 32, floor_id: null, camera: { projection: mode === "plan" ? "orthographic" : "perspective", near: camera.near, far: camera.far, world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray() },
    depth: { encoding: "linear_view_z_8bit_near_white", near: 1, far: 50 }, normals: "view_space_rgb", surface_policy: "opaque_geometry",
    sources: [{ scene_id: root().id, place_id: "place", revision: 1, definition: structuredClone(root().definition), x: 0, z: 0 }], objects: [{ object_id: "building_place", rgb: objectMaskColor(0) }], passes: { render: png, depth: png, normals: png, objects: png } };
}
const input = async (mode?: ViewCapture["mode"]) => ({ id: "view1", label: "Courtyard", capture: await capture(mode) });
beforeEach(() => {
  memory.rows.clear(); memory.files.clear(); memory.owner = true; memory.uploads = 0; memory.onUpload = () => {}; memory.tail = Promise.resolve();
  store("place_scenes").set("world:place", { ...savedScene(), _id: "world:place" });
});
it("downloads the captured view snapshot without re-reading newly changed cameras or geometry", async () => {
  await savePlaceView("world", "place", await input());
  const snapshot = await snapshotPlaceViewExports({ collection } as unknown as Db, "world", {} as ClientSession);
  root().revision++;
  store("place_views").get("world:view1")!.label = "A later name";
  const result = await downloadPlaceViewExports(snapshot);
  expect(result[0]!.view).toMatchObject({ label: "Courtyard", historical: false });
  expect((await placeViewLibrary("world", "place")).views[0]).toMatchObject({ label: "A later name", historical: true });
});
it("round-trips the exact camera fingerprint needed for subsequent illustration editing", async () => {
  root().definition.entrance = { x: 10, z: 18, yaw: 0 };
  await savePlaceView("world", "place", await input());
  const original = store("place_views").get("world:view1")! as PlaceViewDoc;
  const scene = root(), views = await exportPlaceViews("world");
  const zip = await buildWorldZip([], { entities: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, updated_at: new Date(0) }, { entities: [] }, [], [scene], [], undefined, [], [], [], views, {
    session_id: "world", captured_at: new Date(0).toISOString(), visibility: "owner", scene_heads: [scene], entity_registry: null, workspace: null, external_resources: [],
  });
  const plan = await prepareWorldImport(await readWorldArchive(Buffer.from(zip)), "restored");
  const restored = plan.records.place_views![0] as PlaceViewDoc;
  expect(illustrationDependency(restored)).toEqual(illustrationDependency(original));
  expect(restored.files.render.key).not.toBe(original.files.render.key);
  expect(restored.request_sha256).toBe(original.request_sha256);
});
it.each(["plan", "orbit", "walk"] as const)("persists %s camera provenance and exact PNG bytes without changing scene revisions", async mode => {
  const request = await input(mode); await savePlaceView("world", "place", request);
  const view = (await placeViewLibrary("world", "place")).views[0]!;
  expect(view).toMatchObject({ historical: false, mode, camera: request.capture.camera, provenance: "client_rendered_saved_geometry" });
  expect(view.sources[0]!.definition_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(view).not.toHaveProperty("files"); expect(view).not.toHaveProperty("request_sha256");
  expect(root().revision).toBe(1); expect(root().view_capture_fence).toBe(1); expect(memory.uploads).toBe(4);
  for (const pass of VIEW_PASSES) expect(await placeViewBytes("world", "view1", pass)).toEqual(Buffer.from(request.capture.passes[pass].split(",")[1]!, "base64"));
});
it("replays a lost save response even after geometry changes, without uploading again", async () => {
  const request = await input(); await savePlaceView("world", "place", request); root().revision++;
  expect(await savePlaceView("world", "place", request)).toEqual({ id: "view1" }); expect(memory.uploads).toBe(4);
  expect((await placeViewLibrary("world", "place")).views[0]!.historical).toBe(true);
  await expect(savePlaceView("world", "place", { ...request, label: "Different" })).rejects.toMatchObject({ status: 409 });
});
it.each(["plan", "orbit", "walk"] as const)("refreshes %s geometry at the exact saved camera while preserving history and export lineage", async mode => {
  const original = await input(mode); await savePlaceView("world", "place", original);
  const old = structuredClone(store("place_views").get("world:view1")!);
  root().revision++; root().definition.objects[0].height++;
  const fresh = structuredClone(original.capture); fresh.sources[0]!.revision = 2; fresh.sources[0]!.definition = structuredClone(root().definition);
  const request = { id: "view2", label: "Courtyard", refreshed_from: "view1", capture: fresh };
  await savePlaceView("world", "place", request);
  expect(store("place_views").get("world:view1")).toEqual(old);
  const views = (await placeViewLibrary("world", "place")).views;
  expect(views.find(v => v.id === "view1")!.historical).toBe(true);
  expect(views.find(v => v.id === "view2")).toMatchObject({ historical: false, refreshed_from: "view1", camera: original.capture.camera });
  expect(views.find(v => v.id === "view2")).not.toHaveProperty("accepted_illustration_id");
  const exported = await exportPlaceViews("world");
  expect(exported.find(v => v.view.id === "view2")!.view.refreshed_from).toBe("view1");
  root().revision++;
  expect(await savePlaceView("world", "place", request)).toEqual({ id: "view2" });
  expect(memory.uploads).toBe(8); expect(root().revision).toBe(3);
});
it("rejects forged refresh provenance, changed framing and camera paths before uploading", async () => {
  const original = await input(); await savePlaceView("world", "place", original);
  for (const modify of [
    (r: Record<string, unknown> & { capture: ViewCapture }) => { r.refreshed_from = "absent"; },
    (r: Record<string, unknown> & { capture: ViewCapture }) => { r.refreshed_from = r.id; },
    (r: Record<string, unknown> & { capture: ViewCapture }) => { r.capture.camera.world_matrix[12]! += 1; },
    (r: Record<string, unknown> & { capture: ViewCapture }) => { r.capture.width = 64; },
    (r: Record<string, unknown> & { capture: ViewCapture }) => { r.capture.floor_id = "another_floor"; },
    (r: Record<string, unknown> & { capture: ViewCapture }) => { const pose = orbitPose(new Vector3(10, 15, 25), new Vector3(10, 0, 10)); r.capture.path = { version: 1, duration: 6, time: 0, pivot: [10, 0, 10], target_id: null, keyframes: [{ ...pose, time: 0 }, { ...pose, time: 1 }] }; },
  ]) {
    const request = { id: "view2", label: "Courtyard", refreshed_from: "view1", capture: structuredClone(original.capture) };
    modify(request); await expect(savePlaceView("world", "place", request)).rejects.toBeInstanceOf(Error);
  }
  store("place_views").get("world:view1")!.root_place_id = "other";
  await expect(savePlaceView("world", "place", { ...original, id: "view2", refreshed_from: "view1" })).rejects.toMatchObject({ status: 409 });
  expect(memory.uploads).toBe(4); expect(store("place_views").size).toBe(1);
});
it("rechecks the refresh ancestor and geometry during publication", async () => {
  const original = await input(); await savePlaceView("world", "place", original);
  const request = { ...original, id: "view2", refreshed_from: "view1" };
  memory.onUpload = () => { store("place_views").delete("world:view1"); };
  await expect(savePlaceView("world", "place", request)).rejects.toMatchObject({ status: 409 });
  expect(store("place_views").has("world:view2")).toBe(false); expect(root().view_capture_fence).toBe(1);
});
it("persists a registered camera path through retries, history and private export", async () => {
  const request = await input(), pivot = new Vector3(10, 0, 10), pose = orbitPose(new Vector3(10, 15, 25), pivot);
  request.capture.path = { version: 1, duration: 6, time: 0.5, pivot: pivot.toArray(), target_id: null,
    keyframes: [{ ...pose, time: 0 }, { ...pose, time: 1 }] };
  await savePlaceView("world", "place", request); await savePlaceView("world", "place", request);
  expect((await placeViewLibrary("world", "place")).views[0]!.path).toEqual(request.capture.path);
  expect(memory.uploads).toBe(4); expect(root().revision).toBe(1);
  const changed = structuredClone(request); changed.capture.path!.duration = 8;
  await expect(savePlaceView("world", "place", changed)).rejects.toMatchObject({ status: 409 });
  root().revision++;
  const views = await exportPlaceViews("world");
  expect(views[0]!.view).toMatchObject({ historical: true, path: request.capture.path });
  const zip = await JSZip.loadAsync(await buildWorldZip([], null, null, [], [], [], undefined, [], [], [], views));
  expect(JSON.parse(await zip.file("place-views.json")!.async("string"))[0].path).toEqual(request.capture.path);
});
async function motionInput() {
  const request = await input(), building = request.capture.sources[0]!.definition.objects[0]!;
  const pivot = new Vector3(building.x, building.height / 2, building.z), position = new Vector3(10, 15, 25);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.copy(position); camera.lookAt(pivot); camera.updateMatrixWorld();
  request.capture.camera.world_matrix = camera.matrixWorld.toArray();
  const pose = orbitPose(position, pivot);
  request.capture.path = { version: 1, duration: 6, time: 0, pivot: pivot.toArray(), target_id: building.id,
    keyframes: [{ ...pose, time: 0 }, { ...pose, azimuth: pose.azimuth + 20, distance: pose.distance * 0.8, time: 1 }] };
  return request;
}
it("prepares deterministic source-bound camera motion without submissions or writes", async () => {
  await savePlaceView("world", "place", await motionInput());
  const original = structuredClone(store("place_views").get("world:view1"));
  const first = await cameraMotionPreview("world", "view1"), second = await cameraMotionPreview("world", "view1");
  expect(second).toEqual(first);
  expect(first).toMatchObject({ status: "calibration_required", generation_enabled: false, source: { view_id: "view1", image: { kind: "render" } } });
  expect(first.preparation_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.source.image.sha256).toBe(original!.files.render.sha256);
  expect(first.source.sources).toEqual(original!.sources);
  expect(first).not.toHaveProperty("files");
  expect(JSON.stringify(first)).not.toContain(original!.files.render.key);
  expect(store("place_views").get("world:view1")).toEqual(original);
  expect(memory.uploads).toBe(4);
  expect([...memory.rows.keys()].filter(name => name.endsWith("_jobs"))).toEqual([]);
});
it("binds accepted artwork and invalidates preparation when the selection changes", async () => {
  await savePlaceView("world", "place", await motionInput());
  const view = store("place_views").get("world:view1")! as PlaceViewDoc;
  const renderPlan = await cameraMotionPreview("world", "view1");
  store("illustration_assets").set("world:art", { _id: "world:art", id: "art", session_id: "world", sha256: "a".repeat(64), view_dependency: illustrationDependency(view) });
  view.accepted_illustration_id = "art";
  const artPlan = await cameraMotionPreview("world", "view1");
  expect(artPlan.source.image).toMatchObject({ kind: "accepted_illustration", asset_id: "art", sha256: "a".repeat(64) });
  expect(artPlan.preparation_sha256).not.toBe(renderPlan.preparation_sha256);
  expect(artPlan.path).toEqual(renderPlan.path);
  expect(artPlan.source.sources).toEqual(renderPlan.source.sources);
  store("illustration_assets").get("world:art")!.view_dependency.input_sha256 = "wrong";
  await expect(cameraMotionPreview("world", "view1")).rejects.toMatchObject({ status: 409 });
  store("illustration_assets").clear();
  await expect(cameraMotionPreview("world", "view1")).rejects.toMatchObject({ status: 409 });
});
it("rejects stale geometry and altered same-revision structure before motion preparation", async () => {
  await savePlaceView("world", "place", await motionInput());
  root().revision++;
  await expect(cameraMotionPreview("world", "view1")).rejects.toMatchObject({ status: 409 });
  root().revision--; root().definition.objects[0].height++;
  await expect(cameraMotionPreview("world", "view1")).rejects.toMatchObject({ status: 409 });
});
it("rejects foreign ownership, invalid identifiers and missing motion views", async () => {
  await savePlaceView("world", "place", await motionInput());
  memory.owner = false;
  await expect(cameraMotionPreview("world", "view1")).rejects.toMatchObject({ status: 403 });
  memory.owner = true;
  await expect(cameraMotionPreview("world", "missing")).rejects.toMatchObject({ status: 404 });
  await expect(cameraMotionPreview("world", "../view1")).rejects.toMatchObject({ status: 400 });
});
it("keeps the camera mapping fingerprint tied to saved path parameters", async () => {
  const request = await motionInput(); await savePlaceView("world", "place", request);
  const first = await cameraMotionPreview("world", "view1");
  request.id = "view2"; request.capture.path!.duration = 8;
  await savePlaceView("world", "place", request);
  const second = await cameraMotionPreview("world", "view2");
  expect(first.preparation_sha256).not.toBe(second.preparation_sha256);
  expect(second.parameters.duration).toBe(8);
  expect(first.source.image.sha256).toBe(second.source.image.sha256);
});
it("rejects saved static captures and malformed camera metadata for motion", async () => {
  await savePlaceView("world", "place", await input());
  await expect(cameraMotionPreview("world", "view1")).rejects.toMatchObject({ status: 400 });
  const request = await motionInput(); request.id = "view2";
  await savePlaceView("world", "place", request);
  store("place_views").get("world:view2")!.camera.projection_matrix = [];
  await expect(cameraMotionPreview("world", "view2")).rejects.toMatchObject({ status: 400 });
});
async function studyInput() {
  const original = await motionInput(); await savePlaceView("world", "place", original);
  const prepared = await cameraMotionPreview("world", "view1");
  const frames = prepared.reference_cameras.map(frame => ({ time: frame.time, seconds: frame.seconds,
    measurements: { forged: true }, capture: { ...structuredClone(original.capture), path: undefined,
      camera: { ...original.capture.camera, world_matrix: frame.world_matrix, projection_matrix: frame.projection_matrix } } }));
  return { id: "study", label: "Inn motion", preparation_sha256: prepared.preparation_sha256, frames };
}
it("revalidates a stored motion study and returns its exact decoded source without writes", async () => {
  await saveMotionStudy("world", "view1", await studyInput());
  const study = store("motion_studies").get("world:study")! as MotionStudyDoc, uploads = memory.uploads;
  const current = await currentMotionStudy({ collection } as unknown as Db, "world", "study", viewHash(study));
  expect(current.study).toEqual(study);
  const source = await motionSourceImage(current.study);
  expect(source).toMatchObject({ width: 32, height: 32, sha256: study.source.image.sha256, bytes: study.source.image.bytes });
  expect(Buffer.from(source.url.split(",")[1]!, "base64")).toEqual(memory.files.get(study.source.image.key));
  expect(memory.uploads).toBe(uploads);
});
it.each(["digest", "parameters", "geometry", "artwork", "owner"])("rejects %s changes when resolving the real saved motion source", async kind => {
  await saveMotionStudy("world", "view1", await studyInput());
  const study = store("motion_studies").get("world:study")! as MotionStudyDoc;
  if (kind === "parameters") study.preparation.parameters.duration = 12;
  if (kind === "geometry") root().definition.objects[0].height++;
  if (kind === "artwork") store("place_views").get("world:view1")!.accepted_illustration_id = "new-art";
  await expect(currentMotionStudy({ collection } as unknown as Db, kind === "owner" ? "foreign" : "world", "study", kind === "digest" ? "wrong" : undefined)).rejects.toMatchObject({ status: 409 });
});
it.each(["missing", "corrupt", "dimensions", "wide", "webp", "orientation"])("rejects %s source bytes before a provider request can be made", async kind => {
  await saveMotionStudy("world", "view1", await studyInput());
  const study = structuredClone(store("motion_studies").get("world:study")) as MotionStudyDoc;
  const file = study.source.image;
  if (kind === "missing") memory.files.delete(file.key);
  if (kind === "corrupt") memory.files.set(file.key, Buffer.from("corrupt"));
  if (kind === "dimensions") study.source.view.width = 64;
  if (["wide", "webp", "orientation"].includes(kind)) {
    const width = kind === "wide" ? 2048 : 32;
    const image = sharp({ create: { width, height: 32, channels: 3, background: "#5487aa" } });
    const bytes = await (kind === "webp" ? image.webp() : kind === "orientation" ? image.jpeg().withMetadata({ orientation: 6 }) : image.png()).toBuffer();
    memory.files.set(file.key, bytes); file.bytes = bytes.length; file.sha256 = createHash("sha256").update(bytes).digest("hex");
    study.source.view.width = width;
  }
  await expect(motionSourceImage(study)).rejects.toMatchObject({ status: ["missing", "corrupt"].includes(kind) ? 503 : 409 });
});
it("persists reference studies, recomputes measurements and replays without recapture or billing", async () => {
  const request = await studyInput();
  await saveMotionStudy("world", "view1", request);
  const uploads = memory.uploads;
  await saveMotionStudy("world", "view1", request);
  const library = await motionStudyLibrary("world", "view1"), study = library.studies[0]!;
  expect(study).toMatchObject({ id: "study", historical: false, status: "reference_only", preflight: "not_server_attested" });
  expect(study.frames).toHaveLength(5);
  expect(study.frames[0]!.measurements).not.toHaveProperty("forged");
  expect(study.frames[0]!.measurements.unknown_pixels).toBe(32 * 32);
  expect(await motionStudyFrame("world", "study", 0, "render")).toEqual(memory.files.get(store("motion_studies").get("world:study")!.files[0].render.key));
  expect(memory.uploads).toBe(uploads);
  expect([...memory.rows.keys()].filter(name => name.endsWith("_jobs") || name === "spend_ledger")).toEqual([]);
  expect(study).not.toHaveProperty("files"); expect(study).not.toHaveProperty("source");
  root().revision++;
  expect((await motionStudyLibrary("world", "view1")).studies[0]!.historical).toBe(true);
  await expect(saveMotionStudy("world", "view1", request)).resolves.toEqual({ id: "study" });
  expect(await motionStudyFrame("world", "study", 4, "objects")).toBeTruthy();
  expect(memory.uploads).toBe(uploads);
});
it("rejects changed reference cameras, incomplete samples and forged source bindings before uploading", async () => {
  const request = await studyInput();
  const mutations: ((input: typeof request) => void)[] = [
    input => { input.frames.pop(); }, input => { input.frames[0]!.capture.camera.world_matrix[12]!++; },
    input => { input.frames[0]!.time = .1; }, input => { input.preparation_sha256 = "stale"; },
    input => { input.frames[0]!.capture.sources[0]!.definition.objects[0]!.height++; },
    input => { input.frames[0]!.capture.passes.objects = "data:image/png;base64,bad"; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(request); mutate(invalid);
    await expect(saveMotionStudy("world", "view1", invalid)).rejects.toBeInstanceOf(Error);
  }
  expect(memory.uploads).toBe(4); expect(store("motion_studies").size).toBe(0);
});
it("rejects publication racing geometry edits or accepted artwork selection", async () => {
  const request = await studyInput();
  memory.onUpload = () => { root().revision++; };
  await expect(saveMotionStudy("world", "view1", request)).rejects.toMatchObject({ status: 409 });
  expect(store("motion_studies").size).toBe(0);
  root().revision = 1;
  memory.onUpload = () => { store("place_views").get("world:view1")!.accepted_illustration_id = "missing"; };
  await expect(saveMotionStudy("world", "view1", request)).rejects.toMatchObject({ status: 409 });
  expect(store("motion_studies").size).toBe(0);
});
it("requires ownership and verifies saved source and reference bytes", async () => {
  const request = await studyInput();
  memory.owner = false;
  for (const run of [() => saveMotionStudy("world", "view1", request), () => motionStudyLibrary("world", "view1"), () => motionStudyFrame("world", "study", 0, "render")]) await expect(run()).rejects.toMatchObject({ status: 403 });
  memory.owner = true;
  const sourceKey = store("place_views").get("world:view1")!.files.render.key, original = memory.files.get(sourceKey)!;
  memory.files.set(sourceKey, Buffer.from("corrupt"));
  await expect(saveMotionStudy("world", "view1", request)).rejects.toMatchObject({ status: 503 });
  memory.files.set(sourceKey, original);
  await saveMotionStudy("world", "view1", request);
  await expect(saveMotionStudy("world", "view1", { ...request, label: "Other" })).rejects.toMatchObject({ status: 409 });
  memory.files.delete(store("motion_studies").get("world:study")!.files[0].render.key);
  await expect(motionStudyFrame("world", "study", 0, "render")).rejects.toMatchObject({ status: 503 });
  await expect(motionStudyFrame("world", "study", 99, "render")).rejects.toMatchObject({ status: 404 });
});
it("serializes duplicate study saves and retains one immutable record", async () => {
  const request = await studyInput();
  const results = await Promise.all([saveMotionStudy("world", "view1", request), saveMotionStudy("world", "view1", request)]);
  expect(results).toEqual([{ id: "study" }, { id: "study" }]);
  expect(store("motion_studies").size).toBe(1);
});
it("retains blocked client preflight as unverified evidence and rejects malformed reports", async () => {
  const request = await studyInput();
  const report = { status: "blocked", samples: 12, clearance: .2, visibility: "sampled",
    issues: [{ kind: "collision", time: .25, end_time: .5 }] };
  for (const invalid of [{ ...report, status: "clear" }, { ...report, samples: Infinity },
    { ...report, issues: [{ kind: "collision", time: .8, end_time: .1 }] }]) {
    await expect(saveMotionStudy("world", "view1", { ...request, client_preflight: invalid })).rejects.toMatchObject({ status: 400 });
  }
  expect(memory.uploads).toBe(4);
  await saveMotionStudy("world", "view1", { ...request, client_preflight: report });
  root().revision++;
  expect((await motionStudyLibrary("world", "view1")).studies[0]).toMatchObject({ historical: true,
    preflight: "not_server_attested", client_preflight: report });
});
it("rejects camera/path mismatches before storing bytes", async () => {
  const request = await input(), pose = orbitPose(new Vector3(10, 15, 25), new Vector3(10, 0, 10));
  request.capture.path = { version: 1, duration: 6, time: 0, pivot: [10, 0, 10], target_id: null, keyframes: [{ ...pose, time: 0 }, { ...pose, time: 1 }] };
  request.capture.path.keyframes[0]!.azimuth += 20;
  await expect(savePlaceView("world", "place", request)).rejects.toMatchObject({ status: 400 });
  expect(memory.uploads).toBe(0);
});
it("serializes duplicate publication and rejects competing contents", async () => {
  const request = await input(); await Promise.all([savePlaceView("world", "place", request), savePlaceView("world", "place", request)]);
  expect(store("place_views").size).toBe(1); expect(root().view_capture_fence).toBe(1);
});
it("requires ownership before reading, decoding or storing private views", async () => {
  const request = await input(); memory.owner = false;
  for (const run of [() => savePlaceView("world", "place", request), () => placeViewLibrary("world", "place"), () => placeViewBytes("world", "view1", "depth")]) await expect(run()).rejects.toMatchObject({ status: 403 });
  expect(memory.uploads).toBe(0); expect(store("place_views").size).toBe(0);
});
it("rejects stale or draft source geometry and incorrect mask IDs before uploading", async () => {
  for (const mutate of [(c: ViewCapture) => { c.sources[0]!.revision++; }, (c: ViewCapture) => { c.sources[0]!.definition.objects[0]!.height++; }, (c: ViewCapture) => { c.objects[0]!.rgb = [255, 0, 0]; }]) {
    const request = await input(); mutate(request.capture); await expect(savePlaceView("world", "place", request)).rejects.toBeInstanceOf(Error);
  }
  expect(memory.uploads).toBe(0);
});
it("rejects a geometry race during blob upload without publishing or incrementing its fence", async () => {
  const request = await input(); memory.onUpload = () => { root().revision++; };
  await expect(savePlaceView("world", "place", request)).rejects.toMatchObject({ status: 409 });
  expect(store("place_views").size).toBe(0); expect(root().view_capture_fence).toBeUndefined();
});
it("does not publish partial storage and permits retry with the same capture identity", async () => {
  const request = await input(); memory.onUpload = () => { if (memory.uploads === 2) throw new Error("Storage offline"); };
  await expect(savePlaceView("world", "place", request)).rejects.toThrow("Storage offline"); expect(store("place_views").size).toBe(0);
  memory.onUpload = () => {}; await savePlaceView("world", "place", request); expect(store("place_views").size).toBe(1); expect(memory.files.size).toBe(4);
});
it("verifies saved pass hashes and distinguishes missing/corrupt bytes", async () => {
  await savePlaceView("world", "place", await input());
  const doc = store("place_views").get("world:view1")! as PlaceViewDoc;
  memory.files.set(doc.files.depth.key, Buffer.alloc(doc.files.depth.bytes));
  await expect(placeViewBytes("world", "view1", "depth")).rejects.toMatchObject({ status: 503 });
  memory.files.delete(doc.files.render.key); await expect(placeViewBytes("world", "view1", "render")).rejects.toMatchObject({ status: 503 });
  await expect(placeViewBytes("world", "absent", "render")).rejects.toMatchObject({ status: 404 });
});
it("binds immutable assets and marks changed or missing asset metadata historical", async () => {
  root().definition.objects[0].asset_id = "mesh1";
  store("mesh_assets").set("world:mesh1", { _id: "world:mesh1", session_id: "world", sha256: "a".repeat(64) });
  await savePlaceView("world", "place", await input());
  expect((await placeViewLibrary("world", "place")).views[0]!.assets).toEqual([{ kind: "mesh", id: "mesh1", sha256: "a".repeat(64) }]);
  store("mesh_assets").get("world:mesh1")!.sha256 = "b".repeat(64);
  expect((await placeViewLibrary("world", "place")).views[0]!.historical).toBe(true);
  store("mesh_assets").clear(); expect((await placeViewLibrary("world", "place")).views[0]!.historical).toBe(true);
});
it("pins ground-only material dependencies and rejects missing or obsolete ground captures", async () => {
  root().definition.ground_material = { asset_id: "soil", tile_metres: 4, rotation: 0, roughness: 1 };
  const request = await input();
  store("material_assets").set("other:soil", { _id: "other:soil", session_id: "other", sha256: "a".repeat(64) });
  await expect(savePlaceView("world", "place", request)).rejects.toBeInstanceOf(Error);
  expect(memory.uploads).toBe(0);
  store("material_assets").set("world:soil", { _id: "world:soil", session_id: "world", sha256: "a".repeat(64) });
  await savePlaceView("world", "place", request);
  expect((await placeViewLibrary("world", "place")).views[0]!.assets).toEqual([{ kind: "material", id: "soil", sha256: "a".repeat(64) }]);
  expect((await exportPlaceViews("world"))[0]!.view.assets).toEqual([{ kind: "material", id: "soil", sha256: "a".repeat(64) }]);
  root().definition.ground_material.tile_metres = 8;
  await expect(savePlaceView("world", "place", { ...request, id: "view2" })).rejects.toMatchObject({ status: 409 });
  expect((await placeViewLibrary("world", "place")).views[0]!.historical).toBe(true);
  expect(memory.uploads).toBe(4);
});
it("validates every PNG and its dimensions before any upload", async () => {
  for (const bad of ["data:image/png;base64,YQ==", "data:image/jpeg;base64,YQ==", "data:image/png;base64,===="]) {
    const request = await input(); request.capture.passes.normals = bad;
    await expect(savePlaceView("world", "place", request)).rejects.toBeInstanceOf(Error);
  }
  const request = await input(); request.capture.width = 33;
  await expect(savePlaceView("world", "place", request)).rejects.toMatchObject({ status: 400 }); expect(memory.uploads).toBe(0);
});
it("enforces the per-place limit before storage", async () => {
  for (let i = 0; i < 50; i++) store("place_views").set(`old${i}`, { _id: `old${i}`, session_id: "world", root_place_id: "place" });
  await expect(savePlaceView("world", "place", await input())).rejects.toMatchObject({ status: 409 }); expect(memory.uploads).toBe(0);
});
it("rejects singular, reflected, scaled, invalid-depth and mismatched projection metadata", async () => {
  const valid = await capture();
  for (const mutate of [(c: ViewCapture) => { c.camera.world_matrix.fill(0); }, (c: ViewCapture) => { c.camera.world_matrix[0]! *= 2; }, (c: ViewCapture) => { for (let i = 0; i < 3; i++) c.camera.world_matrix[i]! *= -1; }, (c: ViewCapture) => { c.camera.projection_matrix.fill(0); }, (c: ViewCapture) => { c.camera.near = 2; }, (c: ViewCapture) => { c.camera.world_matrix[3] = 0.1; }, (c: ViewCapture) => { c.mode = "plan"; }, (c: ViewCapture) => { c.depth.far = 101; }]) {
    const bad = structuredClone(valid); mutate(bad); expect(() => parseCaptureMetadata(bad)).toThrow();
  }
  const c = parseCaptureMetadata({ ...valid, injected: "discard", camera: { ...valid.camera, bogus: true } });
  expect(c).not.toHaveProperty("injected"); expect(c.camera).not.toHaveProperty("bogus");
});
it("assigns 1,000 distinct non-background object colors", () => {
  const colors = Array.from({ length: 1000 }, (_, i) => objectMaskColor(i).join(","));
  expect(new Set(colors).size).toBe(1000); expect(colors).not.toContain("0,0,0");
});
it("exports exact PNGs, camera bindings and history without private storage keys or new writes", async () => {
  const request = await input(); await savePlaceView("world", "place", request); root().revision++;
  const views = await exportPlaceViews("world"); expect(views[0]!.view.historical).toBe(true);
  const zip = await JSZip.loadAsync(await buildWorldZip([], null, null, [], [], [], undefined, [], [], [], views));
  const manifest = await zip.file("place-views.json")!.async("string"); expect(manifest).not.toContain("world/views/");
  expect(JSON.parse(manifest)[0].capture_metadata.request_sha256).toBe(store("place_views").get("world:view1")!.request_sha256);
  expect(JSON.parse(manifest)[0]).toMatchObject({ camera: JSON.parse(JSON.stringify(request.capture.camera)), historical: true, provenance: "client_rendered_saved_geometry" });
  for (const pass of VIEW_PASSES) expect(await zip.file(`views/1/${pass}.png`)!.async("uint8array")).toEqual(new Uint8Array(Buffer.from(request.capture.passes[pass].split(",")[1]!, "base64")));
  expect(memory.uploads).toBe(4); memory.owner = false; await expect(exportPlaceViews("world")).rejects.toMatchObject({ status: 403 });
});
it("binds both connected chunks and marks an invalidated frame historical", async () => {
  const a = structuredClone(root()) as PlaceSceneSnapshot, b = savedScene("next"); const geos = sceneGeos(a, []); geos.push(adjacentPlacement(a, b, "east", geos));
  const connection: PlaceConnection = { id: "link", version: 1, kind: "boundary", a: { place_id: "place", side: "east", offset: 10 }, b: { place_id: "next", side: "west", offset: 10 }, width: 3, created_at: new Date(0).toISOString() };
  store("place_scenes").set("world:next", { ...b, _id: "world:next" }); store("world_map").set("world", { _id: "world", entities: geos });
  store("place_connections").set("world:link", { ...connection, _id: "world:link", session_id: "world" });
  const request = await input("walk"), network = networkView(placeNetwork("place", [a, b], geos, [connection])!, "place");
  request.capture.sources = network.chunks.map(({ scene: s, x, z }) => ({ scene_id: s.id, place_id: s.place_id, revision: s.revision, definition: s.definition, x, z }));
  request.capture.objects = ["building_next", "building_place"].map((object_id, i) => ({ object_id, rgb: objectMaskColor(i) }));
  await savePlaceView("world", "place", request); expect((await placeViewLibrary("world", "place")).views[0]!.historical).toBe(false);
  expect(store("world_map").get("world")!.view_capture_fence).toBe(1);
  store("world_map").get("world")!.entities.find((g: { id: string }) => g.id === "next").pos.x += 1;
  expect((await placeViewLibrary("world", "place")).views[0]!.historical).toBe(true);
});
