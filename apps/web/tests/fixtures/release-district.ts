import type { PlaceSceneDefinition, PlaceSceneObject, RoomLayout } from "@openflipbook/config";
import { acceptPlacePlan } from "../../lib/place-build";
import { emptyPlaceScene, newComponent } from "../../lib/place-scene";

/** Authored free acceptance fixture. It is not evidence of model output quality. */
export function releaseDistrict(style: "fantasy" | "contemporary"): PlaceSceneDefinition {
  const names = style === "fantasy" ? ["Copper Kettle", "Clock Tower", "Guild Hall", "Lantern Library", "Glasshouse", "Canal House", "Market Hall", "Stone Workshop"]
    : ["Corner Cafe", "Station Office", "Community Hall", "Public Library", "Greenhouse", "Riverside Home", "Market", "Repair Workshop"];
  const colors = ["#b99b80", "#91a2b1", "#aeb79b", "#ad9aaf", "#89b3a2", "#c7ab93", "#b7a87b", "#a4a8ad"];
  const room = (prefix: string): RoomLayout => ({ type: "split", id: `${prefix}_partition`, axis: "x", position: 1.5,
    door: { id: `${prefix}_door`, offset: 0, width: 1.2, height: 2.2 }, a: { type: "room", id: `${prefix}_hall`, label: "Hall" },
    b: { type: "room", id: `${prefix}_study`, label: "Study" } });
  const objects: PlaceSceneObject[] = names.map((label, i) => {
    const o = newComponent("building", 12 + i % 4 * 18, 15 + Math.floor(i / 4) * 35), prefix = `landmark${i}`;
    o.id = prefix; o.entity_id = `${prefix}_entity`; o.label = label; o.color = colors[i]!;
    o.structure!.floors = [{ id: `${prefix}_ground`, label: "Ground floor", ...(i < 2 ? { layout: room(`${prefix}_ground`) } : {}) }];
    if (i === 0) { o.height = 7.8; o.structure!.floors.push({ id: `${prefix}_upper`, label: "Upper floor", layout: room(`${prefix}_upper`) }); }
    o.structure!.door.id = `${prefix}_entrance`; o.structure!.windows[0]!.id = `${prefix}_window`; return o;
  });
  for (const [i, floor] of [[0, "ground"], [0, "upper"], [1, "ground"]] as const) {
    const id = `prop_${i}_${floor}`, o = newComponent("bench", 2.5, 2);
    objects.push({ ...o, id, entity_id: `${id}_entity`, label: floor === "upper" ? "Upstairs reading seat" : "Room seat", width: .8, depth: .8,
      placement: { building_id: `landmark${i}`, floor_id: `landmark${i}_${floor}` } });
  }
  const base = { ...emptyPlaceScene(), label: style === "fantasy" ? "Lantern district" : "Riverside district", width: 80, depth: 80, entrance: { x: 40, z: 77, yaw: 0 } };
  return acceptPlacePlan(base, { objects }, `release_${style}`);
}
