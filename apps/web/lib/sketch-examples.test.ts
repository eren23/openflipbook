import { expect, it } from "vitest";
import { sketchExample } from "./sketch-examples";
import { parseSketch } from "./sketch-types";
it("loads a bounded material-only environment example", () => {
  const example = sketchExample("drum")!;
  expect(example.image).toBe("/demos/ankh-morpork/street-environment.png");
  expect(parseSketch(example.state)).toMatchObject({ scope: "region", workflow: "material", output: "environment", model: "nano" });
  expect(example.state.scene.elements).toEqual([]);
});
it("does not turn the example query into an arbitrary image fetch", () => {
  for (const value of [null, "", "https://example.com/x.png", "../../secret", "other"]) expect(sketchExample(value)).toBeNull();
});
it("opens the saved edit as the next editable source without reapplying the old prompt", () => {
  const example = sketchExample("drum-teal")!;
  expect(example.image).toBe("/demos/ankh-morpork/street-edit.png");
  expect(example.state.prompt).toBe("");
  expect(example.state.scene.elements).toEqual([]);
});
