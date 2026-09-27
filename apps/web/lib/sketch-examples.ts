import { blankSketch, type SketchState } from "./sketch-types";
import { DRUM_ENVIRONMENT, DRUM_EDIT } from "./drum-assets";

export function sketchExample(name: string | null): { image: string; state: SketchState } | null {
  if (name !== "drum" && name !== "drum-teal") return null;
  return { image: name === "drum-teal" ? DRUM_EDIT : DRUM_ENVIRONMENT, state: {
    ...blankSketch(), title: "The Mended Drum / roof material", model: "nano", workflow: "material", material: "custom", output: "environment", scope: "region",
    prompt: name === "drum-teal" ? "" : "Change ONLY the central Mended Drum tavern's red terracotta roof tiles to weathered dark teal glazed tiles. Preserve the exact roof outline, ridge, tile layout, chimney positions, perspective, timber structure, and all other buildings. This is a material-only correction, not new architecture. Remove annotation marks. Do not change the sky, walls, signs, street, barrels or well.",
  } };
}
