import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import GeometryMapArtwork, { type GeometryMapContext } from "./geometry-map-artwork";
import { captureGeometryMap } from "./geometry-map-capture";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
vi.mock("./geometry-map-capture", () => ({ captureGeometryMap: vi.fn().mockResolvedValue({ version: 1, camera: { saved: true } }) }));
vi.mock("./place-illustrations", () => ({ default: ({ view }: { view: { id: string } }) => <p>Saved map illustration {view.id}</p> }));
const fetcher = vi.fn();
const initial = (): GeometryMapContext => ({ kind: "geometry_derived", scene: { id: "scene", session_id: "world", place_id: "place", revision: 2,
  source_node_id: null, source_image_key: null, updated_at: "2026-10-03T00:00:00Z", definition: { ...emptyPlaceScene(), objects: [{ ...newComponent("building", 20, 20), id: "inn", label: "Copper Kettle" }] } }, views: [] });
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetcher); history.replaceState(null, "", "/sketch/world/map?world=world&place=place"); });
it("saves one geometry camera and retries the exact capture after a lost acknowledgement", async () => {
  const context = initial(), bodies: string[] = []; let lost = true;
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json(context);
    bodies.push(String(init.body)); if (lost) { lost = false; throw new Error("Lost map acknowledgement"); }
    return Response.json({ id: "map1" });
  });
  render(<GeometryMapArtwork initial={context}/>);
  fireEvent.click(screen.getByRole("button", { name: "Capture map camera" })); await screen.findByText("Lost map acknowledgement");
  expect(captureGeometryMap).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Retry saving map camera" }));
  await waitFor(() => expect(bodies).toHaveLength(2)); expect(bodies[1]).toBe(bodies[0]); expect(captureGeometryMap).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url)).toEqual([
    "/api/world/world/places/place/derived-map", "/api/world/world/places/place/derived-map"]);
});
it("keeps a selected named building connected to its 3D link without generating images", () => {
  render(<GeometryMapArtwork initial={initial()}/>);
  fireEvent.change(screen.getByLabelText("Selected world object"), { target: { value: "inn" } });
  expect(screen.getByRole("link", { name: "Open selected object in 3D" }).getAttribute("href")).toContain("object=inn");
  expect(location.search).toContain("object=inn"); expect(fetcher).not.toHaveBeenCalled();
});
