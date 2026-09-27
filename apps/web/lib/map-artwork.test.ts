import { describe, expect, it } from "vitest";
import { ankhStreetScene } from "./ankh-scene";
import { newComponent } from "./place-scene";
import { mapChanges, mapObject, mapRepaintState, parseMapRegistration } from "./map-artwork";
const frame = { width: 1600, height: 900 }, r = { x: 45, y: 59, width: 10, rotation: 0 };
describe("geometry-driven map artwork", () => {
  it("maps metres uniformly without stretching a landscape chart", () => {
    const d = ankhStreetScene(), o = newComponent("house", 20, 12);
    const p = mapObject(o, d, r, frame);
    expect(p).toMatchObject({ cx: 720, cy: 531, width: 20, height: 20, rotation: 0 });
    expect(mapObject({ ...o, x: 23 }, d, { ...r, rotation: 90 }, frame).cy).toBe(543);
  });
  it("prepares old and new footprints and protected masks from a revision delta", () => {
    const before = ankhStreetScene(), after = structuredClone(before);
    after.objects.find(o => o.kind === "tavern")!.width = 9.4;
    const workshop = newComponent("house", 22.5, 14.5); workshop.label = "Filigree workshop"; after.objects.push(workshop);
    const state = mapRepaintState(before, after, r, frame, 3);
    expect(state.scope).toBe("region"); expect(state.model).toBe("nano"); expect(state.prompt).toContain("ADD \"Filigree workshop\"");
    expect(state.scene.elements.filter(e => e.customData?.role === "mask")).toHaveLength(2);
    expect(state.scene.elements.filter(e => e.customData?.role === "remove")).toHaveLength(1);
    expect(mapChanges(before, after)).toHaveLength(2);
    expect(before.objects).toHaveLength(21);
  });
  it("covers a moved object's old and new locations without relocating unrelated objects", () => {
    const before = ankhStreetScene(), after = structuredClone(before), o = after.objects.find(o => o.kind === "tavern")!; o.x += 5;
    const state = mapRepaintState(before, after, { ...r, rotation: 20 }, frame, 2);
    const mask = state.scene.elements.find(e => e.customData?.role === "mask")!;
    for (const object of [before.objects.find(p => p.id === o.id)!, o]) for (const p of mapObject(object, before, { ...r, rotation: 20 }, frame).points) {
      expect(p.x).toBeGreaterThan(mask.x); expect(p.x).toBeLessThan(mask.x + mask.width); expect(p.y).toBeGreaterThan(mask.y); expect(p.y).toBeLessThan(mask.y + mask.height);
    }
  });
  it("supports removals and refuses empty, invalid or changed-coordinate-frame requests", () => {
    const d = ankhStreetScene(), after = structuredClone(d); after.objects = after.objects.filter(o => o.kind !== "tavern");
    expect(mapRepaintState(d, after, r, frame, 2).prompt).toContain("REMOVE");
    expect(() => mapRepaintState(d, d, r, frame, 2)).toThrow(/No object changes/);
    expect(() => mapRepaintState(d, { ...after, width: 50 }, r, frame, 2)).toThrow(/place dimensions/);
    expect(() => mapRepaintState(d, after, { ...r, x: 0, y: 0 }, frame, 2)).toThrow(/inside/);
    for (const bad of [{ ...r, width: 0 }, { ...r, x: NaN }, { ...r, rotation: Infinity }]) expect(() => parseMapRegistration(bad)).toThrow();
  });
});
