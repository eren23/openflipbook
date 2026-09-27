import { expect, it } from "vitest";
import { ankhStreetScene } from "./ankh-scene";
import { alignedDrumScene, alignmentPoints, alignmentResult, DRUM_ALIGNMENT } from "./drum-alignment";
import { parsePlaceScene, sceneChanges } from "./place-scene";

it("matches the independent SciPy projection receipt", () => {
  for (const profile of ["original", "vertical_only", "free_camera", "shape_fit"] as const) {
    const expected = alignmentResult(profile);
    for (const point of alignmentPoints(profile)) {
      const recorded = expected.anchors.find(anchor => anchor.id === point.id)!;
      expect(point.projected[0]).toBeCloseTo(recorded.projected[0]!, 6);
      expect(point.projected[1]).toBeCloseTo(recorded.projected[1]!, 6);
    }
  }
});
it("improves vertical fit without moving the ground truth hypothesis or camera", () => {
  const original = alignmentResult("original"), fitted = alignmentResult("vertical_only");
  expect(fitted.fit_rms_px).toBeLessThan(original.fit_rms_px * 0.55);
  expect(fitted.held_out_rms_px).toBe(original.held_out_rms_px);
  expect(fitted.parameters.slice(0, 6)).toEqual(original.parameters.slice(0, 6));
  expect(alignmentResult("free_camera").held_out_rms_px).toBeGreaterThan(original.held_out_rms_px);
  expect(DRUM_ALIGNMENT.selected).toBe("shape_fit");
});
it("keeps scene identity, footprints and entrance unchanged in a non-mutating preview", () => {
  const source = ankhStreetScene(), before = structuredClone(source);
  const { definition, eaveHeights } = alignedDrumScene(source, "vertical_only");
  expect(source).toEqual(before);
  expect(definition.entrance).toEqual(source.entrance);
  for (let i = 0; i < source.objects.length; i++) {
    const { height: originalHeight, ...original } = source.objects[i]!;
    const { height, eave_height: _eaves, ...fitted } = definition.objects[i]!;
    expect(fitted).toEqual(original);
    if (original.kind === "tavern") { expect(height).toBeGreaterThan(originalHeight); expect(eaveHeights[original.id]).toBeLessThan(height); }
    else expect(height).toBe(originalHeight);
  }
});
it("fits roof and rear depth while fixing the front wall and independent ground checks", () => {
  const source = ankhStreetScene(), before = structuredClone(source);
  const { definition } = alignedDrumScene(source, "shape_fit");
  expect(parsePlaceScene(definition)).toEqual(definition);
  expect(source).toEqual(before);
  expect(definition.entrance).toEqual(source.entrance);
  const tavern = definition.objects.find(o => o.kind === "tavern")!;
  expect(tavern.z - tavern.depth / 2).toBeCloseTo(13, 8);
  expect(tavern.depth).toBeGreaterThan(7);
  expect(tavern.roof_offset).toBeCloseTo(2);
  expect(definition.objects.map(o => [o.id, o.entity_id])).toEqual(source.objects.map(o => [o.id, o.entity_id]));
  for (const kind of ["well", "barrels"]) expect(definition.objects.find(o => o.kind === kind)).toEqual(source.objects.find(o => o.kind === kind));
  expect(sceneChanges(source, definition).some(change => change.includes("footprint: 10.00 x 5.40 m -> 10.00 x 7.16 m"))).toBe(true);
  const fit = alignmentResult("shape_fit"), original = alignmentResult("original");
  expect(fit.parameters.slice(0, 6)).toEqual(original.parameters.slice(0, 6));
  expect(fit.fit_rms_px).toBeLessThan(alignmentResult("vertical_only").fit_rms_px * 0.53);
  expect(fit.held_out_rms_px).toBe(original.held_out_rms_px);
});
