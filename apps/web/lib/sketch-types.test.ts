import { describe, it, expect } from "vitest";
import {
  blankSketch,
  parseSketch,
  rasterDataUrl,
  SKETCH_MODELS,
  sketchWorkflowError,
} from "./sketch-types";
const element = {
  id: "a",
  type: "rectangle",
  x: 20,
  y: 30,
  width: 40,
  height: 50,
};
describe("sketch document contract", () => {
  it("does not treat Excalidraw's null-to-empty binding normalization as an edit", () => {
    const scene = (boundElements: null | never[]) => ({
      ...blankSketch(),
      scene: { elements: [{ ...element, boundElements }], files: {} },
    });
    expect(parseSketch(scene(null))).toEqual(parseSketch(scene([])));
  });
  it("starts with an editable square and the explicit Flare route", () => {
    const state = blankSketch();
    expect(parseSketch(state)).toEqual(state);
    expect(SKETCH_MODELS[state.model].endpoint).toBe(
      "openai/gpt-image-2.5/flare/edit",
    );
  });
  it("round-trips workflow settings without rewriting user instructions", () => {
    const s = {
      ...blankSketch(),
      workflow: "placement" as const,
      subject_data_url: "data:image/png;base64,YQ==",
      prompt: "My exact words",
    };
    expect(parseSketch(s)).toEqual(s);
    expect(sketchWorkflowError(s, true)).toBeNull();
    expect(sketchWorkflowError(s, false)).toMatch(/scene/);
    expect(
      sketchWorkflowError({ ...s, subject_data_url: undefined }, true),
    ).toMatch(/reference/);
    expect(sketchWorkflowError({ ...s, scope: "whole" }, true)).toMatch(
      /selected-area/,
    );
  });
  it("requires explicit whole-image scope for viewpoint proposals", () => {
    const s = { ...blankSketch(), workflow: "viewpoint" as const };
    expect(sketchWorkflowError(s, false)).toMatch(/source/);
    expect(sketchWorkflowError(s, true)).toMatch(/whole-image/);
    expect(sketchWorkflowError({ ...s, scope: "whole" }, true)).toBeNull();
  });
  it.each([
    { workflow: "mesh" },
    { output: "__proto__" },
    { material: "unknown" },
    { viewpoint: "calibrated" },
    { subject_data_url: "https://external/image.png" },
  ])("rejects invalid workflow fields: %s", (fields) => {
    expect(() => parseSketch({ ...blankSketch(), ...fields })).toThrow();
  });
  it.each([
    null,
    [],
    {},
    { ...blankSketch(), model: "__proto__" },
    { ...blankSketch(), frame: { width: Infinity, height: 10 } },
    { ...blankSketch(), prompt: "x".repeat(5001) },
  ])("rejects malformed settings", (input) =>
    expect(() => parseSketch(input)).toThrow(),
  );
  it.each([
    "https://host/image.png",
    "data:image/svg+xml;base64,YQ==",
    "data:image/png;base64,!!!",
  ])("refuses external and active images: %s", (value) =>
    expect(rasterDataUrl(value)).toBe(false),
  );
  it("preserves typed instructions separately from mask geometry", () => {
    const s = blankSketch();
    s.scene.elements = [
      { ...element, customData: { role: "instruction" } },
      { ...element, id: "b", customData: { role: "mask" } },
    ];
    expect(parseSketch(s).scene.elements).toHaveLength(2);
  });
  it.each([
    { ...element, type: "embeddable" },
    { ...element, x: NaN },
    { ...element, link: "javascript:alert(1)" },
    { ...element, type: "arrow", customData: { role: "mask" } },
  ])("rejects unsafe elements", (e) => {
    const s = blankSketch();
    s.scene.elements = [e];
    expect(() => parseSketch(s)).toThrow();
  });
  it("rejects too many embedded images", () => {
    const s = blankSketch();
    s.scene.files = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        i,
        {
          id: String(i),
          dataURL: "data:image/png;base64,YQ==",
          mimeType: "image/png",
          created: 0,
        },
      ]),
    );
    expect(() => parseSketch(s)).toThrow("five");
  });
});
