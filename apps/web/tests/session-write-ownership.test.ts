import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Two routes wrote into a session without asking who was writing. A session id
// is in every /play?continue= link and every published session, so anyone who
// could see a world could change it.

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  verifyOwnerReadonly: vi.fn(),
  getNode: vi.fn(),
  setNodeWalk: vi.fn(),
  applyEntityEdits: vi.fn(),
  getWorldMap: vi.fn(),
  getWorldState: vi.fn(),
  inlineStoredImage: vi.fn(),
}));

vi.mock("@/lib/session-owner", () => mocks);
vi.mock("@/lib/db", () => mocks);
vi.mock("@/lib/r2", () => mocks);
vi.mock("@/lib/world", () => mocks);
vi.mock("@/lib/world-map", () => ({
  ...mocks,
  blastRadius: () => ({}),
  buildGeoReferences: () => [],
}));
vi.mock("@/lib/env", () => ({
  readServerEnv: () => ({ MODAL_API_URL: "https://modal.test", MONGODB_URI: "mongodb://test", MONGODB_DB: "test" }),
}));
vi.mock("@/lib/env-flag", () => ({ envFlag: () => true }));

import { POST as editEntities } from "@/app/api/world/[sessionId]/edit-entities/route";
import { POST as walk } from "@/app/api/world/[sessionId]/walk/route";

const forbidden = () => ({
  ok: false,
  res: NextResponse.json({ error: "this session belongs to another browser" }, { status: 403 }),
});
const inSession = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) });
const post = (body: unknown) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

const upstream = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  process.env.MODAL_API_URL = "https://modal.test";
  mocks.requireOwner.mockResolvedValue({ ok: true });
  mocks.verifyOwnerReadonly.mockResolvedValue({ ok: true });
  mocks.getWorldMap.mockResolvedValue({ entities: [], bounds: { x: 0, y: 0, w: 0, h: 0 } });
  mocks.getWorldState.mockResolvedValue({ entities: [] });
  mocks.getNode.mockResolvedValue({ id: "n1", session_id: "s1" });
  vi.stubGlobal("fetch", upstream);
});

describe("editing a world's map", () => {
  it("refuses someone who does not own the session, before spending or writing", async () => {
    mocks.requireOwner.mockResolvedValue(forbidden());
    const res = await editEntities(post({ instruction: "move the inn north" }), inSession("s1"));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled(); // the paid planner
    expect(mocks.applyEntityEdits).not.toHaveBeenCalled();
  });

  it("lets the owner through", async () => {
    // an owner with something to edit -- an empty map is refused as 409
    mocks.getWorldMap.mockResolvedValue({
      entities: [{ id: "geo_inn", entity_id: "inn", label: "Inn", pos: { x: 0, y: 0 }, height: 6, footprint: { w: 8, d: 6 }, visual: "" }],
      bounds: { x: 0, y: 0, w: 8, h: 6 },
    });
    upstream.mockResolvedValue(new Response(JSON.stringify({ edits: [] }), { status: 200 }));
    await editEntities(post({ instruction: "move the inn north" }), inSession("s1"));
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("keeping a painted walk", () => {
  const painted = { clips: [{ from_shot: 0, to_shot: 1, video_url: "https://v/c.mp4", model: "m", seconds: 5 }], spent_usd: 0.6 };
  const body = { node_id: "n1", shots: [{ index: 0, distance: 0, sees: [["Hall", 0.3]] }] };

  beforeEach(() => {
    upstream.mockResolvedValue(new Response(JSON.stringify(painted), { status: 200 }));
  });

  it("keeps it on the owner's own node", async () => {
    await walk(post(body), inSession("s1"));
    expect(mocks.setNodeWalk).toHaveBeenCalledTimes(1);
    expect(mocks.setNodeWalk.mock.calls[0]![0]).toBe("n1");
  });

  it("does not write into a session the caller does not own", async () => {
    mocks.verifyOwnerReadonly.mockResolvedValue(forbidden());
    await walk(post(body), inSession("s1"));
    expect(mocks.setNodeWalk).not.toHaveBeenCalled();
  });

  it("does not write a node that belongs to a different session than the url names", async () => {
    // the caller owns s1 and names somebody else's node in the body
    mocks.getNode.mockResolvedValue({ id: "n1", session_id: "someone-else" });
    await walk(post(body), inSession("s1"));
    expect(mocks.setNodeWalk).not.toHaveBeenCalled();
  });

  it("passes the snap-point spec to the backend as it came", async () => {
    const spec = {
      observer: { x: 1, y: 2, gaze: 0.5, fov: 1.57, eye_height: 1.7, pitch: 0 },
      move: { forward: 12, turn_deg: -30 },
      objects: [{ label: "Hall", visual: "stone", h_pos: "left", v_pos: "mid", size: "large", distance: 4, height: 7.5, share: 0.3 }],
      ground: [{ label: "The River", side: "right" }],
    };
    await walk(post({ ...body, shots: [{ ...body.shots[0], ...spec }] }), inSession("s1"));
    const sent = JSON.parse(String(upstream.mock.calls[0]![1].body));
    expect(sent.shots[0]).toMatchObject(spec);
  });

  it("keeps the merged video with the walk", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ ...painted, video_url: "https://v/walk.mp4" }), { status: 200 }));
    await walk(post(body), inSession("s1"));
    expect(mocks.setNodeWalk.mock.calls[0]![1]).toMatchObject({ video_url: "https://v/walk.mp4", clips: painted.clips });
  });

  it("still hands back the walk it painted, kept or not", async () => {
    mocks.verifyOwnerReadonly.mockResolvedValue(forbidden());
    const res = await walk(post(body), inSession("s1"));
    expect(res.status).toBe(200);
    expect((await res.json()).clips).toHaveLength(1);
  });
});
