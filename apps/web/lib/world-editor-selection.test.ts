import { expect, it } from "vitest";
import { emptyPlaceScene, newComponent } from "./place-scene";
import { worldEditorSelection, worldEditorHref } from "./world-editor-selection";

function fixture() {
  const inn = { ...newComponent("building", 8, 10), id: "inn", label: "House" }, other = { ...newComponent("building", 20, 10), id: "other", label: "House" };
  const floor = inn.structure!.floors[0]!.id, bench = { ...newComponent("bench", 0, 0), id: "bench", placement: { building_id: inn.id, floor_id: floor } };
  return { definition: { ...emptyPlaceScene(), objects: [inn, other, bench] }, floor, otherFloor: other.structure!.floors[0]!.id };
}
it("selects by exact place-local ID, never by a repeated label", () => {
  const {definition} = fixture(); expect(worldEditorSelection(definition, "other", null)).toEqual({ object_id:"other",floor_id:null });
  expect(worldEditorSelection(definition, "House", null).object_id).toBeNull();
  expect(worldEditorSelection(definition, "deleted", null).object_id).toBeNull();
});
it("restores a furnishing's real floor, ignoring an unrelated or malicious floor argument", () => {
  const {definition, floor, otherFloor} = fixture();
  for(const requested of [null,"missing",otherFloor])expect(worldEditorSelection(definition,"bench",requested)).toEqual({object_id:"bench",floor_id:floor});
});
it("keeps a building's own room context but never another building's floor", () => {
  const {definition,floor,otherFloor}=fixture();
  expect(worldEditorSelection(definition,"inn",floor).floor_id).toBe(floor);
  expect(worldEditorSelection(definition,"inn",otherFloor).floor_id).toBeNull();
  expect(worldEditorSelection(definition,null,floor).floor_id).toBe(floor);
  expect(worldEditorSelection(definition,null,"deleted").floor_id).toBeNull();
});
it("encodes canonical world, place, object, floor, view and camera without retaining stale source links", () => {
  const url = new URL(worldEditorHref({session_id:"world",place_id:"place"},{object_id:"inn",floor_id:"room"},{map:true,view:"split",camera:"camera"}),"http://localhost");
  expect(url.pathname).toBe("/sketch/world/map");expect(Object.fromEntries(url.searchParams)).toEqual({world:"world",place:"place",object:"inn",floor:"room",view:"split",camera:"camera"});
  expect(worldEditorHref({session_id:"world",place_id:"place"},{object_id:null,floor_id:null})).toBe("/sketch/world?world=world&place=place");
});
it("carries a /play walk route for the walk view", () => {
  const url = new URL(worldEditorHref({session_id:"world",place_id:"place"},{object_id:null,floor_id:null},{view:"walk",route:"1.00,-2.50,0.30;0.00,0.00,1.57"}),"http://localhost");
  expect(Object.fromEntries(url.searchParams)).toEqual({world:"world",place:"place",view:"walk",route:"1.00,-2.50,0.30;0.00,0.00,1.57"});
});
