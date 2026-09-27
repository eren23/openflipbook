import { describe, expect, it } from "vitest";
import { blankSketch } from "./sketch-types";
import { exportBundle, importSketch } from "./sketch-files";

describe("portable Sketch scenes", () => {
  it("round-trips an OpenFlipbook bundle without merging the clean source into annotations", async () => {
    const source = "data:image/png;base64,YQ==";
    const state = {
      ...blankSketch(),
      prompt: "A red roof",
      workflow: "placement" as const,
      subject_data_url: "data:image/png;base64,Yg==",
      style_data_url: "data:image/png;base64,Yw==",
    };
    const blob = await exportBundle(state, source, source);
    const file = new File([blob], "harbor.ofb-sketch");
    expect(await importSketch(file)).toEqual({ state, source });
  });
  it("imports a standard Excalidraw scene and brings negative coordinates into its frame", async () => {
    const file = new File(
      [
        JSON.stringify({
          type: "excalidraw",
          elements: [
            {
              id: "a",
              type: "rectangle",
              x: -20,
              y: -30,
              width: 100,
              height: 100,
            },
          ],
          files: {},
        }),
      ],
      "Drawing.excalidraw",
    );
    const result = await importSketch(file);
    expect(result.state.title).toBe("Drawing");
    expect(result.state.scene.elements[0]).toMatchObject({ x: 0, y: 0 });
    expect(result.source).toBeUndefined();
  });
  it("rejects links and oversized element collections before calculating bounds", async () => {
    const shape = {
      id: "a",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    };
    for (const elements of [
      [{ ...shape, link: "https://example.com" }],
      Array(5001).fill(shape),
    ]) {
      await expect(
        importSketch(
          new File(
            [JSON.stringify({ type: "excalidraw", elements })],
            "bad.excalidraw",
          ),
        ),
      ).rejects.toThrow();
    }
  });
  it("rejects oversized decompressed bundle entries", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("sketch.json", "x".repeat(9 * 1024 * 1024));
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
    });
    await expect(
      importSketch(new File([blob], "large.ofb-sketch")),
    ).rejects.toThrow("size limit");
  });
});
