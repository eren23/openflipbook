/* eslint-disable @typescript-eslint/no-explicit-any -- schemaless test doubles (in-memory Mongo rows, page JSON) */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { drumWorldEditorUrl, importDrumWorld } from "./drum-world-client";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());
it("imports the existing map and both image versions into one retry-stable world, without generation", async () => {
  const writes: { body: any; key: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/demos/")) return new Response(new Blob(["pixels"], { type: "image/png" }));
    expect(url).toBe("/api/nodes");
    const key = (init!.headers as Record<string, string>)["Idempotency-Key"]!;
    writes.push({ key, body: JSON.parse(init!.body as string) });
    return Response.json({ id: key });
  }));
  const first = await importDrumWorld(), retry = await importDrumWorld();
  expect(retry).toEqual(first);
  expect(writes.slice(3)).toEqual(writes.slice(0, 3));
  expect(new Set(writes.map(w => w.body.session_id)).size).toBe(1);
  expect(writes[1]!.body).toMatchObject({ parent_id: first.map, relation: "descend", click_in_parent: { x_pct: 43.4, y_pct: 61.4 } });
  expect(writes[2]!.body).toMatchObject({ parent_id: first.source, relation: "edit", image_model: "imported-demo-asset" });
  expect(writes[0]!.body.image_data_url).toMatch(/^data:image\/png;base64,/);
  expect(writes[0]!.body.scene_view).toMatchObject({ level: "map", observer: null });
  for (const write of writes.slice(1, 3)) expect(write.body.scene_view).toMatchObject({ level: "street", observer: null, map_crop: null });
});
it("surfaces asset and ownership errors without continuing the import", async () => {
  const fetch = vi.fn(async () => new Response("missing", { status: 404 })); vi.stubGlobal("fetch", fetch);
  await expect(importDrumWorld()).rejects.toThrow("load the saved demo image");
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async (url?: unknown) => url === "/api/nodes" ? Response.json({ error: "Not owner" }, { status: 403 }) : new Response(new Blob(["pixels"])));
  await expect(importDrumWorld()).rejects.toThrow("Not owner");
});
it("encodes stable source and place links", () => {
  expect(drumWorldEditorUrl("source", "place_source")).toBe("/sketch/world?source=source&place=place_source");
  expect(drumWorldEditorUrl("a&b")).toBe("/sketch/world?source=a%26b");
});
