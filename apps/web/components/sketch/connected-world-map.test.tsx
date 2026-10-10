import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PlaceNetwork, PlaceSceneSnapshot } from "@openflipbook/config";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";
import ConnectedWorldMap from "./connected-world-map";

const root: PlaceSceneSnapshot = { id: "scene_root", session_id: "world", place_id: "root", revision: 2, source_node_id: null, source_image_key: null, updated_at: new Date(0).toISOString(), definition: { ...emptyPlaceScene(), label: "Market", width: 40, depth: 40, entrance: { x: 20, z: 38, yaw: 0 }, objects: [{ ...newComponent("building", 10, 10), id: "workshop", label: "Workshop" }] } };
const east: PlaceSceneSnapshot = { ...root, id: "scene_east", place_id: "east", definition: { ...root.definition, label: "Canal", objects: [{ ...newComponent("building", 10, 10), id: "tea", label: "Tea house" }] } };
const network: PlaceNetwork = { chunks: [{ scene: root, x: -16, z: -40 }, { scene: east, x: 24, z: -40 }], connections: [{ id: "opening", version: 1, kind: "boundary", a: { place_id: "root", side: "east", offset: 20 }, b: { place_id: "east", side: "west", offset: 20 }, width: 3, created_at: root.updated_at }] };
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
});
function mount() {
  const props = { network, placeId: "root", walkPose: { version: 1 as const, place_id: "root", scene_revision: 2, position: { x: 20, y: .82, z: 38 }, yaw: 0, pitch: 0 }, onClose: vi.fn(), onOpenPlace: vi.fn(), onWalk: vi.fn(), canWalk: true };
  return { props, ...render(<ConnectedWorldMap {...props}/>) };
}
it("shows a full spatial map with a correctly normalized walking marker and real openings", () => {
  mount(); expect(screen.getByRole("dialog", { name: "World map" })).toBeTruthy();
  expect(screen.getByText("80 × 40 m · 2 places · 2 buildings")).toBeTruthy();
  expect(screen.getByTestId("world-map-walk-marker").getAttribute("data-x")).toBe("20");
  expect(screen.getByRole("button", { name: "Select Tea house in Canal" })).toBeTruthy();
  expect(screen.getByText("Market ↔ Canal · 3 m opening")).toBeTruthy();
});
it("chooses a building in another place, explains boundary travel, and opens its exact identity", () => {
  const { props } = mount(); fireEvent.click(screen.getByRole("button", { name: "Select Tea house in Canal" }));
  expect(within(screen.getByRole("region", { name: "Map selection" })).getByText("Tea house")).toBeTruthy();
  expect(screen.getByText("3 m boundary opening")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit selection" })); expect(props.onOpenPlace).toHaveBeenCalledWith("east", "tea");
  expect(network.chunks[1]!.scene.definition.objects[0]!.x).toBe(10);
});
it("zooms and fits the whole district without moving the saved pose", () => {
  const { props } = mount(), svg = screen.getByTestId("connected-world-map"), fitted = svg.getAttribute("viewBox");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in world map" })); expect(svg.getAttribute("viewBox")).not.toBe(fitted);
  fireEvent.click(screen.getByRole("button", { name: "Fit world" })); expect(svg.getAttribute("viewBox")).toBe(fitted);
  fireEvent.click(screen.getByRole("button", { name: "Continue walking" })); expect(props.onWalk).toHaveBeenCalledOnce(); expect(props.onOpenPlace).not.toHaveBeenCalled();
});
it("captures map keyboard events before background walking and closes on Escape", () => {
  const { props } = mount(), background = vi.fn(); window.addEventListener("keydown", background);
  try { fireEvent.keyDown(screen.getByRole("button", { name: "Fit world" }), { key: "ArrowUp" }); expect(background).not.toHaveBeenCalled();
    fireEvent(screen.getByRole("dialog", { name: "World map" }), new Event("cancel", { cancelable: true })); expect(props.onClose).toHaveBeenCalledOnce();
  } finally { window.removeEventListener("keydown", background); }
});
