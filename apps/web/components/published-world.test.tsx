import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { PlaceSceneDefinition } from "@openflipbook/config";
import type { WorldPublication } from "@/lib/world-publication";
const state = vi.hoisted(() => ({ viewport: {} as Record<string, unknown> }));
vi.mock("next/dynamic", () => ({ default: () => (props: Record<string, unknown>) => {
  state.viewport = props;
  return <button onClick={() => (props.onPlaceChange as (place: string) => void)("yard")}>Walk to yard</button>;
} }));
import PublishedWorld from "./published-world";
const definition: PlaceSceneDefinition = { version: 1, units: "authored_metres", label: "City", width: 80, depth: 80,
  entrance: { x: 1, z: 1, yaw: 0 }, objects: [] };
const world: WorldPublication = { id: "published", version: 1, title: "Two places", created_at: "2026-10-03T00:00:00.000Z",
  scenes: [{ place_id: "city", revision: 2, definition }, { place_id: "yard", revision: 3, definition: { ...definition, label: "Yard" } }],
  placements: [{ place_id: "city", entity_id: "entity_city", pos: { x: 40, y: 40 }, footprint: { w: 80, d: 80 }, scale: 1, heading: 0, elevation: 0 },
    { place_id: "yard", entity_id: "entity_yard", pos: { x: 120, y: 40 }, footprint: { w: 80, d: 80 }, scale: 1, heading: 0, elevation: 0 }],
  connections: [{ id: "gate", version: 1, kind: "boundary", a: { place_id: "city", side: "east", offset: 40 },
    b: { place_id: "yard", side: "west", offset: 40 }, width: 2, created_at: "2026-10-03T00:00:00.000Z" }],
  views: [{ id: "old_view", label: "Original city", mode: "orbit", floor_id: null, file_id: "view_old",
    capture: { provenance: "client_rendered_saved_geometry", historical: true, sources: [{ place_id: "city", revision: 1 }] } }],
  videos: [{ id: "old_video", label: "Camera path", duration: 3, file_id: "video_old",
    capture: { provenance: "client_rendered_saved_geometry", historical: true, sources: [{ place_id: "yard", revision: 2 }] } }], assets: [],
};
const fetcher = vi.fn();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); state.viewport = {}; });

it("walks the frozen selected network and carries the traversed place into plan/orbit without writes", () => {
  render(<PublishedWorld world={world}/>);
  expect(screen.getByRole("status").textContent).toContain("2 connected places");
  fireEvent.change(screen.getByLabelText("View"), { target: { value: "walk" } });
  expect(state.viewport).toMatchObject({ placeId: "city", mode: "walk", network: { connections: [{ id: "gate" }] } });
  fireEvent.click(screen.getByRole("button", { name: "Walk to yard" }));
  expect(screen.getByRole("status").textContent).toContain("Yard");
  fireEvent.change(screen.getByLabelText("View"), { target: { value: "plan" } });
  expect(state.viewport).toMatchObject({ placeId: "yard", mode: "plan", definition: { label: "Yard" } });
  for (const paidOrWriteCallback of ["onWalkPose", "captureSnapshot", "getWalkPose", "onCaptureReady"]) expect(state.viewport[paidOrWriteCallback]).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it("shows historical capture revisions alongside current geometry and uses public allowlisted media URLs", () => {
  render(<PublishedWorld world={world}/>);
  expect(screen.getByText("Historical capture geometry · City revision 1")).toBeTruthy();
  expect(screen.getByText("Historical capture geometry · Yard revision 2")).toBeTruthy();
  expect((screen.getByRole("img", { name: "Original city" }) as HTMLImageElement).getAttribute("src")).toBe("/api/publications/published/files/view_old");
  expect(document.querySelector("video")?.getAttribute("src")).toBe("/api/publications/published/files/video_old");
});

it("keeps a copied snapshot library private and labels unknown legacy capture provenance", () => {
  const legacy = structuredClone(world); delete legacy.views[0]!.capture;
  render(<PublishedWorld world={legacy} privateSession="forked"/>);
  expect(screen.getByText("Capture revision unavailable in this legacy snapshot")).toBeTruthy();
  expect((screen.getByRole("img", { name: "Original city" }) as HTMLImageElement).getAttribute("src")).toBe("/api/world/forked/publication-files/view_old");
  expect(screen.queryByRole("button", { name: "Fork selected content" })).toBeNull();
});
