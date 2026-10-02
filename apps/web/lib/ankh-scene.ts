import type { PlaceComponent, PlaceSceneDefinition, PlaceSceneObject } from "@openflipbook/config";
import { newComponent } from "./place-scene";
import type { WalkWaypoint } from "./walk-route";

export const ANKH_MAP = "/demos/ankh-morpork/map.png";
// Visually located on the generated chart, not the original prompt coordinates.
// The illustration is not surveyed geometry; the street scene is independently authored.
export const DRUM_MAP_ANCHOR = { x: 43.4, y: 61.4 };
export const DRUM_APPROACH: readonly WalkWaypoint[] = [
  { x: 34.2, z: 10.4, yaw: Math.PI, hold: 0.4 },
  { x: 34.2, z: 10.4, yaw: Math.PI / 2, hold: 0.4 },
  { x: 12.6, z: 10.6, yaw: Math.PI / 2, hold: 0.4 },
  { x: 12.6, z: 10.6, yaw: Math.PI, hold: 1.5 },
  { x: 12.6, z: 12, yaw: Math.PI, hold: 1.5 },
  { x: 12.6, z: 12, yaw: 0, hold: 1.5 },
  { x: 12.6, z: 12, yaw: -Math.PI / 2, hold: 1.5 },
];
// The tour status line. Only the Drum approach names the Drum: recording
// scripts wait for that text, and a /play hand-off can be any route.
export const routeWords = (route: readonly WalkWaypoint[]) => route === DRUM_APPROACH
  ? { walking: "Walking to the Drum", end: "At the Mended Drum" }
  : { walking: "Walking the route", end: "Route end" };

export function ankhStreetScene(): PlaceSceneDefinition {
  const objects: PlaceSceneObject[] = [];
  const add = (id: string, kind: PlaceComponent, label: string, x: number, z: number, patch: Partial<PlaceSceneObject> = {}) => {
    objects.push({ ...newComponent(kind, x, z), ...patch, id: `drum_${id}_${crypto.randomUUID()}`, label });
  };
  const road = (id: string, label: string, from: [number, number], to: [number, number], width: number) => {
    const dx = to[0] - from[0], dz = to[1] - from[1];
    add(id, "path", label, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { width: Math.hypot(dx, dz), depth: width, heading: Math.atan2(dz, dx), height: 0.025, color: "#a4aaa5" });
  };
  road("filigree_west", "Filigree Street west", [0.2, 9.8], [12.6, 10.6], 2.8);
  road("filigree", "Filigree Street", [12.6, 10.6], [34.2, 10.4], 2.8);
  road("filigree_east", "Filigree Street east", [34.2, 10.4], [39.5, 11.6], 2.8);
  road("short_north", "Short Street north", [18.8, 1.6], [34.2, 5.2], 3);
  road("short_junction", "Short Street junction", [34.2, 5.2], [34.2, 10.4], 3);
  road("short_south", "Short Street south", [34.2, 10.4], [38.7, 17.6], 3);
  add("forecourt", "path", "Doorstep recess", 12.6, 12.3, { width: 2.4, depth: 1.4 });
  add("tavern", "tavern", "The Mended Drum", 13, 15.7);
  add("opposite", "house", "Pale-roof house", 14.2, 5.4, { width: 10, depth: 6, height: 6.5, color: "#c2c8ba" });
  add("well", "well", "Junction well", 25.3, 12.8);
  add("barrels", "barrels", "Drum barrels", 19.3, 14);
  add("passage", "path", "East service passage", 19, 17.8, { width: 2, depth: 6.4 });
  add("yard", "path", "Rear yard", 12.8, 20, { width: 8.8, depth: 2.4, color: "#889184" });
  add("yard_back", "wall", "Yard boundary", 12.8, 21.5, { width: 9.5, height: 1.5 });
  add("yard_west", "wall", "Yard west wall", 8.1, 20, { width: 3, height: 1.5, heading: Math.PI / 2 });
  for (const [id, x, z, w, d, h, color] of [
    ["west_1", 4, 4.5, 6, 7, 7.5, "#526d6f"],
    ["west_2", 3.8, 15, 6, 5, 6.4, "#78665b"],
    ["north_1", 23.5, 6.7, 6, 3, 5.5, "#747e88"],
    ["south_1", 24.4, 18.7, 6.5, 5, 7.2, "#687b69"],
    ["south_2", 31.1, 20.2, 5, 5.8, 8, "#875347"],
    ["east_1", 38, 5.6, 3.6, 6.8, 7, "#647a80"],
  ] as const) add(id, "house", "Filigree house", x, z, { width: w, depth: d, height: h, color });
  return { version: 1, label: "Filigree Street / The Mended Drum", width: 40, depth: 24, units: "authored_metres", entrance: { x: 34.2, z: 6, yaw: Math.PI }, objects };
}
