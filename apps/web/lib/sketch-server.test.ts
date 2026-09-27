/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const memory = vi.hoisted(() => ({
  collections: new Map<string, Map<string, any>>(),
  owner: true,
  nodes: [] as any[],
  uploads: [] as string[],
}));
function collection(name: string) {
  if (!memory.collections.has(name)) memory.collections.set(name, new Map());
  const rows = memory.collections.get(name)!;
  const matches = (d: any, q: any) =>
    Object.entries(q).every(([k, v]: any) =>
      v && typeof v === "object"
        ? "$ne" in v
          ? d[k] !== v.$ne
          : "$exists" in v
            ? (d[k] !== undefined) === v.$exists
            : "$in" in v
              ? v.$in.includes(d[k])
              : false
        : d[k] === v,
    );
  const find = (q: any) => [...rows.values()].filter((d) => matches(d, q));
  return {
    findOne: async (q: any) => structuredClone(find(q)[0] ?? null),
    insertOne: async (d: any) => {
      if (rows.has(d._id))
        throw Object.assign(new Error("duplicate"), { code: 11000 });
      rows.set(d._id, structuredClone(d));
    },
    replaceOne: async (q: any, d: any) => {
      if (!find(q).length) return { matchedCount: 0 };
      rows.set(d._id, structuredClone(d));
      return { matchedCount: 1 };
    },
    deleteOne: async (q: any) => {
      for (const d of find(q)) rows.delete(d._id);
    },
    updateOne: async (q: any, update: any, options?: any) => {
      let d = find(q)[0];
      if (!d && options?.upsert) {
        d = { _id: q._id };
        rows.set(d._id, d);
      }
      if (!d) return { matchedCount: 0 };
      Object.assign(d, structuredClone(update.$set ?? {}));
      for (const [k, n] of Object.entries(update.$inc ?? {}))
        d[k] = (d[k] ?? 0) + Number(n);
      return { matchedCount: 1 };
    },
    find: (q: any) => {
      const cursor = {
        sort: () => cursor,
        limit: () => cursor,
        project: () => cursor,
        toArray: async () => structuredClone(find(q)),
      };
      return cursor;
    },
  };
}
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "owner" }) }),
}));
vi.mock("./db", () => ({
  getDb: async () => ({ collection }),
  getNode: async (id: string) => ({
    id,
    session_id: "world",
    image_key: "clean.png",
  }),
  insertNode: async (n: any) => {
    memory.nodes.push(n);
  },
  withDbTransaction: async (fn: any) => fn({ collection }, {}),
}));
vi.mock("./session-owner", () => ({
  requireOwner: async () => ({ ok: true }),
}));
vi.mock("./creator", async (original) => ({
  ...(await original<object>()),
  requireCreator: async () => {
    if (!memory.owner)
      throw Object.assign(new Error("Not owner"), { status: 403 });
    return { collection };
  },
}));
vi.mock("./r2", () => ({
  getStoredBytes: async () => ({
    bytes: Buffer.from("a"),
    contentType: "image/png",
  }),
  decodeDataUrl: () => ({ bytes: Buffer.from("a"), contentType: "image/png" }),
  uploadJpeg: async (key: string) => {
    memory.uploads.push(key);
    return { key };
  },
}));
import { blankSketch } from "./sketch-types";
import { ankhStreetScene } from "./ankh-scene";
import { mapArtworkContext } from "./map-artwork-server";
import {
  acceptSketch,
  createSketch,
  createMapArtworkSketch,
  deleteSketch,
  discardSketchCandidate,
  generateSketch,
  listSketches,
  readSketch,
  restoreSketch,
  saveSketch,
  sketchEnabled,
  sketchSource,
} from "./sketch-server";
const png = "data:image/png;base64,YQ==";
const req = (body: any, key = "request-1") =>
  new Request("http://local/api/sketches", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
async function create(extra = {}) {
  return (
    await (await createSketch(req({ state: blankSketch(), ...extra }))).json()
  ).sketch;
}
async function generate(d: any, key = "request-1") {
  const body = {
    sketch_id: d.id,
    sketch_revision: d.revision,
    sketch_exports: { guide: png, mask: png },
  };
  return generateSketch(req(body, key), body);
}
beforeEach(() => {
  memory.collections.clear();
  memory.nodes = [];
  memory.uploads = [];
  memory.owner = true;
  vi.stubEnv("NEXT_PUBLIC_SKETCH_ENABLED", "1");
  vi.stubEnv("MODAL_API_URL", "http://backend");
  vi.stubEnv("MAX_DAILY_SPEND", "0");
  vi.stubEnv("MAX_SESSION_SPEND", "0");
  vi.stubEnv("R2_PUBLIC_BASE_URL", "http://images");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: "final", image_data_url: png, outside_changed: 0, mock: true })}\n\n`,
        ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("creates, saves, reads, lists and deletes owner-scoped drafts", async () => {
  const d = await create();
  expect((await readSketch(d.id)).sketch.revision).toBe(1);
  await collection("session_owners").insertOne({
    _id: d.session_id,
    owner_token: "owner",
  });
  expect((await listSketches()).sketches).toHaveLength(1);
  const next = await saveSketch(
    d.id,
    req({ revision: 1, state: { ...d.state, title: "Harbor" } }),
  );
  expect(next.sketch.revision).toBe(2);
  await expect(
    saveSketch(d.id, req({ revision: 1, state: d.state })),
  ).rejects.toMatchObject({ status: 409 });
  await deleteSketch(d.id);
  await expect(readSketch(d.id)).rejects.toMatchObject({ status: 404 });
});
it("binds corrections to the authorized clean source and fixes its frame", async () => {
  const d = await create({ source_node_id: "original" });
  expect(d.session_id).toBe("world");
  expect((await sketchSource(d.id)).headers.get("cache-control")).toBe(
    "private, no-store",
  );
  await expect(
    saveSketch(
      d.id,
      req({
        revision: 1,
        state: { ...d.state, frame: { width: 512, height: 512 } },
      }),
    ),
  ).rejects.toThrow();
  const result = await (await generate(d)).json();
  expect(result.candidate).toMatchObject({
    mock: true,
    outside_changed: 0,
    status: "ready",
  });
  const sent = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
  expect(sent.image).toBe(png);
  expect(sent.sketch_input.kind).toBe("edit");
  expect(sent.max_attempts).toBe(1);
});
it("rejects incomplete workflows before uploads, reservation, or backend calls", async () => {
  for (const [workflow, source, scope, subject] of [
    ["placement", false, "region", png],
    ["placement", true, "region", undefined],
    ["placement", true, "whole", png],
    ["viewpoint", true, "region", undefined],
    ["viewpoint", false, "whole", undefined],
  ]) {
    const d = await create({
      ...(source ? { source_node_id: "original" } : {}),
      state: { ...blankSketch(), workflow, scope, subject_data_url: subject },
    });
    await expect(generate(d)).rejects.toMatchObject({ status: 400 });
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(memory.uploads).toHaveLength(0);
  expect(memory.collections.get("sketch_runs")?.size ?? 0).toBe(0);
});
it("sends distinct object and style references and restores workflow provenance", async () => {
  const d = await create({
    source_node_id: "original",
    state: {
      ...blankSketch(),
      workflow: "placement",
      subject_data_url: png,
      style_data_url: "data:image/png;base64,Yg==",
      prompt: "Beside the window",
    },
  });
  const result = await (await generate(d)).json();
  const sent = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
  expect(sent.sketch_input).toMatchObject({
    workflow: "placement",
    subject: png,
    style: "data:image/png;base64,Yg==",
    scope: "region",
  });
  expect(sent.query).toBe("Beside the window");
  expect(result.candidate.workflow).toBe("placement");
  await saveSketch(
    d.id,
    req({
      revision: 1,
      state: { ...d.state, workflow: "material", material: "ceramic" },
    }),
  );
  const restored = await restoreSketch(
    d.id,
    req({ candidate_id: result.candidate.id, revision: 2 }),
  );
  expect(restored.sketch.state.workflow).toBe("placement");
  expect(restored.sketch.state.subject_data_url).toBe(png);
});
it("keeps viewpoint output as an edit without claiming verified geometry", async () => {
  const d = await create({
    source_node_id: "original",
    state: {
      ...blankSketch(),
      workflow: "viewpoint",
      scope: "whole",
      viewpoint: "eye_level",
      subject_data_url: png,
    },
  });
  await collection("nodes").insertOne({
    _id: "original",
    session_id: d.session_id,
  });
  const result = await (await generate(d)).json();
  const sent = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
  expect(sent.sketch_input.workflow).toBe("viewpoint");
  expect(sent.sketch_input.subject).toBeUndefined();
  expect(sent.sketch_input.mask).toBeUndefined();
  await acceptSketch(
    d.id,
    req({ candidate_id: result.candidate.id, revision: 1 }),
  );
  expect(memory.nodes[0]).toMatchObject({
    relation: "edit",
    parent_id: "original",
    scene_view: null,
  });
  expect((await readSketch(d.id)).candidates[0]?.workflow).toBe("viewpoint");
});
it("submits once, previews privately, and keeps an immutable node idempotently", async () => {
  const d = await create();
  const result = await (await generate(d)).json();
  expect(memory.nodes).toHaveLength(0);
  expect((await (await generate(d)).json()).candidate.id).toBe(
    result.candidate.id,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = { candidate_id: result.candidate.id, revision: 1 };
  const first = await acceptSketch(d.id, req(body));
  expect(await acceptSketch(d.id, req(body))).toEqual(first);
  expect(memory.nodes).toHaveLength(1);
  expect(memory.nodes[0].final_prompt).toBeNull();
  await expect(discardSketchCandidate(d.id, req(body))).rejects.toMatchObject({
    status: 409,
  });
});
it("restores snapshots monotonically and rejects stale acceptance", async () => {
  const d = await create();
  const { candidate } = await (await generate(d)).json();
  await saveSketch(
    d.id,
    req({ revision: 1, state: { ...d.state, prompt: "Different" } }),
  );
  await expect(
    acceptSketch(d.id, req({ candidate_id: candidate.id, revision: 2 })),
  ).rejects.toMatchObject({ status: 409 });
  await restoreSketch(d.id, req({ candidate_id: candidate.id, revision: 2 }));
  const restored = await readSketch(d.id);
  expect(restored.sketch.revision).toBe(3);
  expect(restored.candidates[0]?.matches_draft).toBe(true);
  await discardSketchCandidate(d.id, req({ candidate_id: candidate.id }));
  expect((await readSketch(d.id)).candidates).toEqual([]);
  await expect(
    acceptSketch(d.id, req({ candidate_id: candidate.id, revision: 3 })),
  ).rejects.toMatchObject({ status: 404 });
});
it("fails closed for missing ownership, invalid input, stale revisions and disabled rollout", async () => {
  const d = await create();
  memory.owner = false;
  await expect(readSketch(d.id)).rejects.toMatchObject({ status: 403 });
  memory.owner = true;
  await expect(createSketch(req({ state: {} }))).rejects.toMatchObject({
    status: 400,
  });
  await expect(generate({ ...d, revision: 99 })).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    generateSketch(req({}), { sketch_id: d.id, sketch_revision: 1 }),
  ).rejects.toMatchObject({ status: 400 });
  vi.stubEnv("NEXT_PUBLIC_SKETCH_ENABLED", "0");
  expect(sketchEnabled()).toBe(false);
  await expect(readSketch(d.id)).rejects.toMatchObject({ status: 404 });
  expect(fetch).not.toHaveBeenCalled();
});
it("reserves the prospective spend before submission and keeps failure receipts", async () => {
  const d = await create();
  vi.stubEnv("MAX_SESSION_SPEND", "0.2");
  const res = await generate(d);
  expect(res.status).toBe(502);
  expect(fetch).not.toHaveBeenCalled();
  expect((await readSketch(d.id)).candidates[0]?.error).toContain("Spend cap");
  vi.stubEnv("MAX_SESSION_SPEND", "1");
  await generate(d);
  expect(fetch).not.toHaveBeenCalled();
});
it("records provider failures without saving a public node", async () => {
  const d = await create({ source_data_url: png });
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('data: {"type":"error","message":"Render unavailable"}\n\n'),
  );
  const res = await generate(d);
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("Render unavailable");
  expect(memory.nodes).toHaveLength(0);
});

async function mapDraft() {
  const d = await create({ source_node_id: "original", state: { ...blankSketch(), scope: "region", workflow: "render" } });
  const binding = { scene_id: "scene", scene_revision: 3, place_id: "place", scene_source_node_id: "street", map_root_node_id: "original", base_map_node_id: "original", baseline_revision: 1, registration: { x: 50, y: 50, width: 20, rotation: 0 } };
  await collection("sketches").updateOne({ _id: d.id }, { $set: { map_repaint: binding } });
  await collection("nodes").insertOne({ _id: "original", session_id: "world" });
  await collection("place_scenes").insertOne({ _id: "geometry", id: "scene", session_id: "world", place_id: "place", revision: 3, definition: { objects: [{ id: "keep-me" }] } });
  return d;
}
it("binds prepared artwork to owned saved geometry and locks accepted placement", async () => {
  vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES", "1");
  const definition = ankhStreetScene(), next = structuredClone(definition);
  next.objects.find(o => o.kind === "tavern")!.roof_material = "teal";
  await collection("place_scenes").insertOne({ _id: "geometry", id: "scene", session_id: "world", place_id: "place", source_node_id: "street", revision: 3, definition: next });
  await collection("place_scene_versions").insertOne({ _id: "baseline", session_id: "world", place_id: "place", revision: 1, definition });
  await collection("nodes").insertOne({ _id: "street", session_id: "world", parent_id: "original" });
  await collection("nodes").insertOne({ _id: "original", session_id: "world", parent_id: null });
  const body = { scene_revision: 3, map_source_node_id: "original", confirmed: true, frame: { width: 1672, height: 941 }, registration: { x: 45.2, y: 59.3, width: 10.3, rotation: 0 } };
  await expect(createMapArtworkSketch(req({ ...body, confirmed: false }), "world", "place")).rejects.toThrow("Review");
  await expect(createMapArtworkSketch(req({ ...body, scene_revision: 2 }), "world", "place")).rejects.toMatchObject({ status: 409 });
  const prepared = await createMapArtworkSketch(req(body), "world", "place");
  expect(prepared.sketch.map_repaint).toMatchObject({ scene_revision: 3, baseline_revision: 1, scene_source_node_id: "street", base_map_node_id: "original" });
  expect(prepared.sketch.state.scope).toBe("region");
  await collection("map_artwork_versions").insertOne({ _id: "previous", session_id: "world", map_root_node_id: "original", scene_id: "scene", scene_revision: 1, registration: body.registration });
  await expect(createMapArtworkSketch(req({ ...body, registration: { ...body.registration, x: 48 } }), "world", "place")).rejects.toThrow("placement is fixed");
  memory.owner = false;
  await expect(createMapArtworkSketch(req(body), "world", "place")).rejects.toMatchObject({ status: 403 });
  expect(fetch).not.toHaveBeenCalled();
});
it("uses a root place's own artwork as an unregistered reference and binds its repaint", async () => {
  vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES", "1");
  const definition = ankhStreetScene(), next = structuredClone(definition);
  next.objects.find(o => o.kind === "tavern")!.roof_material = "teal";
  await collection("place_scenes").insertOne({ _id: "geometry", id: "scene", session_id: "world", place_id: "place", source_node_id: "original", revision: 3, definition: next });
  await collection("place_scene_versions").insertOne({ _id: "baseline", session_id: "world", place_id: "place", revision: 1, definition });
  await collection("nodes").insertOne({ _id: "original", session_id: "world", parent_id: null });
  expect(await mapArtworkContext("world", "place")).toMatchObject({ map: { id: "original", root_id: "original", reference_kind: "place_reference" }, registration: null });
  const body = { scene_revision: 3, map_source_node_id: "original", confirmed: true, frame: { width: 1672, height: 941 }, registration: { x: 50, y: 50, width: 50, rotation: 0 } };
  const prepared = await createMapArtworkSketch(req(body), "world", "place");
  expect(prepared.sketch.map_repaint).toMatchObject({ scene_source_node_id: "original", map_root_node_id: "original", base_map_node_id: "original" });
  expect((await mapArtworkContext("world", "place")).registration).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("does not substitute a root reference when its recorded parent or owned source is missing", async () => {
  vi.stubEnv("NEXT_PUBLIC_WORLD_SCENES", "1");
  await collection("place_scenes").insertOne({ _id: "geometry", id: "scene", session_id: "world", place_id: "place", source_node_id: "street" });
  await expect(mapArtworkContext("world", "place")).rejects.toThrow("reference artwork is missing");
  await collection("nodes").insertOne({ _id: "street", session_id: "foreign", parent_id: null });
  await expect(mapArtworkContext("world", "place")).rejects.toThrow("reference artwork is missing");
  await collection("nodes").updateOne({ _id: "street" }, { $set: { session_id: "world", parent_id: "missing" } });
  await expect(mapArtworkContext("world", "place")).rejects.toThrow("no saved parent map");
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects map generation before spending when saved geometry or artwork changed", async () => {
  const d = await mapDraft();
  await collection("place_scenes").updateOne({ _id: "geometry" }, { $set: { revision: 4 } });
  await expect(generate(d)).rejects.toThrow("Geometry changed");
  await collection("place_scenes").updateOne({ _id: "geometry" }, { $set: { revision: 3 } });
  await collection("map_artwork_heads").insertOne({ _id: "world:original", node_id: "new-map" });
  await expect(generate(d)).rejects.toThrow("Map artwork changed");
  expect(fetch).not.toHaveBeenCalled();
});
it("requires a real protected map result and checks geometry again at acceptance", async () => {
  const d = await mapDraft();
  const { candidate } = await (await generate(d)).json();
  const body = req({ candidate_id: candidate.id, revision: 1 });
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).sketch_input.focus_region).toBe(true);
  await expect(acceptSketch(d.id, body.clone())).rejects.toThrow("real result");
  await collection("sketch_runs").updateOne({ _id: candidate.id }, { $set: { mock: false, outside_changed: 1 } });
  await expect(acceptSketch(d.id, body.clone())).rejects.toThrow("protected pixels");
  await collection("sketch_runs").updateOne({ _id: candidate.id }, { $set: { outside_changed: 0 } });
  await collection("place_scenes").updateOne({ _id: "geometry" }, { $set: { revision: 4 } });
  await expect(acceptSketch(d.id, body.clone())).rejects.toThrow("Geometry changed");
  expect(memory.nodes).toHaveLength(0);
});
it("keeps a map version and head without changing geometry, with idempotent acceptance", async () => {
  const d = await mapDraft();
  const { candidate } = await (await generate(d)).json();
  await collection("sketch_runs").updateOne({ _id: candidate.id }, { $set: { mock: false } });
  const body = { candidate_id: candidate.id, revision: 1 };
  const kept = await acceptSketch(d.id, req(body));
  expect(await collection("map_artwork_heads").findOne({ _id: "world:original" })).toMatchObject({ node_id: kept.node_id });
  expect(await collection("map_artwork_versions").findOne({ _id: kept.node_id })).toMatchObject({ scene_revision: 3, baseline_revision: 1, base_map_node_id: "original" });
  expect(await collection("place_scenes").findOne({ _id: "geometry" })).toMatchObject({ revision: 3, definition: { objects: [{ id: "keep-me" }] } });
  expect(await acceptSketch(d.id, req(body))).toEqual(kept);
  expect(memory.nodes).toHaveLength(1);
});
