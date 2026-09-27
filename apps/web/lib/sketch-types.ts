import type { MapRepaintBinding } from "./map-artwork-binding";

export const SKETCH_MODELS = {
  flare: {
    label: "GPT Image 2.5 Flare",
    endpoint: "openai/gpt-image-2.5/flare/edit",
  },
  sunburst: {
    label: "GPT Image 2.5 Sunburst",
    endpoint: "openai/gpt-image-2.5/sunburst/edit",
  },
  nano: { label: "Nano Banana Pro", endpoint: "fal-ai/nano-banana-pro/edit" },
} as const;
export type SketchModel = keyof typeof SKETCH_MODELS;
export const SKETCH_WORKFLOWS = {
  render: "Finish / correct",
  material: "Material variation",
  placement: "Place an object",
  viewpoint: "Alternate view",
} as const;
export const SKETCH_OUTPUTS = {
  auto: "From your drawing",
  object: "Finished object",
  environment: "Environment",
  artwork: "Artwork",
} as const;
export const SKETCH_MATERIALS = {
  custom: "Custom",
  ceramic: "Glazed ceramic",
  metal: "Brushed metal",
  fabric: "Woven fabric",
  wood: "Natural wood",
  glass: "Translucent glass",
} as const;
export const SKETCH_VIEWS = {
  eye_level: "Eye level",
  overhead: "Overhead",
  front: "Front",
  three_quarter: "Three-quarter",
} as const;
export type SketchWorkflow = keyof typeof SKETCH_WORKFLOWS;
export const SKETCH_RESERVATION = 0.3;
export const MAX_SKETCH_BYTES = 8 * 1024 * 1024;
export type SketchElement = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: Record<string, unknown>;
};
export interface SketchScene {
  elements: SketchElement[];
  files: Record<
    string,
    { id: string; dataURL: string; mimeType: string; created: number }
  >;
}
export interface SketchState {
  version: 1;
  title: string;
  prompt: string;
  model: SketchModel;
  scope: "region" | "whole";
  frame: { width: number; height: number };
  scene: SketchScene;
  style_data_url?: string | undefined;
  workflow?: SketchWorkflow;
  output?: keyof typeof SKETCH_OUTPUTS;
  material?: keyof typeof SKETCH_MATERIALS;
  viewpoint?: keyof typeof SKETCH_VIEWS;
  subject_data_url?: string | undefined;
}
export interface SketchDocument {
  map_repaint?: MapRepaintBinding;
  id: string;
  session_id: string;
  revision: number;
  state: SketchState;
  source_node_id: string | null;
  source_url: string | null;
  updated_at: string;
}
export interface SketchCandidate {
  mock?: boolean;
  id: string;
  draft_id: string;
  revision: number;
  status: "running" | "ready" | "failed";
  image_url?: string;
  saved_node_id?: string;
  error?: string;
  model: string;
  created_at: string;
  outside_changed?: number | undefined;
  reservation: number;
  matches_draft?: boolean;
  workflow?: SketchWorkflow;
}
export function blankSketch(): SketchState {
  return {
    version: 1,
    title: "Untitled sketch",
    prompt: "",
    model: "flare",
    scope: "region",
    frame: { width: 1024, height: 1024 },
    scene: { elements: [], files: {} },
  };
}
export function rasterDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_SKETCH_BYTES * 1.4) return false;
  const header = /^data:image\/(?:png|jpeg|webp);base64,/.exec(value);
  if (!header) return false;
  const data = value.slice(header[0].length), padding = data.indexOf("=");
  // Avoid a quantified whole-payload regexp: V8's interpreter can exhaust its
  // stack on valid multi-megabyte image exports before the regexp is optimized.
  return data.length > 0 && !/[^A-Za-z0-9+/=]/.test(data) &&
    (padding === -1 || (padding > 0 && padding >= data.length - 2 && /^={1,2}$/.test(data.slice(padding))));
}
export function parseSketch(value: unknown): SketchState {
  if (
    !value ||
    typeof value !== "object" ||
    new TextEncoder().encode(JSON.stringify(value)).length > MAX_SKETCH_BYTES
  )
    throw new Error("Sketch exceeds the 8 MiB limit");
  const s = value as SketchState;
  if (
    s.version !== 1 ||
    typeof s.title !== "string" ||
    s.title.length > 160 ||
    typeof s.prompt !== "string" ||
    s.prompt.length > 5000 ||
    !Object.hasOwn(SKETCH_MODELS, s.model) ||
    !["region", "whole"].includes(s.scope)
  )
    throw new Error("Invalid sketch settings");
  if (
    !s.frame ||
    ![s.frame.width, s.frame.height].every(
      (n) => Number.isInteger(n) && n >= 16 && n <= 4096,
    ) ||
    s.frame.width * s.frame.height > 8_294_400
  )
    throw new Error("Invalid canvas dimensions");
  if (
    !s.scene ||
    !Array.isArray(s.scene.elements) ||
    s.scene.elements.length > 5000 ||
    !s.scene.files ||
    typeof s.scene.files !== "object" ||
    Array.isArray(s.scene.files)
  )
    throw new Error("Invalid drawing scene");
  const types = new Set([
    "rectangle",
    "ellipse",
    "diamond",
    "line",
    "arrow",
    "freedraw",
    "text",
    "image",
    "frame",
  ]);
  for (const e of s.scene.elements) {
    if (
      !e ||
      typeof e.id !== "string" ||
      !types.has(e.type) ||
      ![e.x, e.y, e.width, e.height].every(
        (n) => Number.isFinite(n) && Math.abs(n) <= 100_000,
      ) ||
      e.link
    )
      throw new Error("Unsupported drawing element or link");
    if (
      e.customData?.role === "mask" &&
      !["rectangle", "ellipse", "freedraw"].includes(e.type)
    )
      throw new Error("Regions must be rectangles, ellipses, or brush strokes");
  }
  const files = Object.values(s.scene.files);
  if (files.length > 5 || files.some((f) => !f || !rasterDataUrl(f.dataURL)))
    throw new Error("Use up to five embedded PNG, JPEG, or WebP images");
  if (s.style_data_url && !rasterDataUrl(s.style_data_url))
    throw new Error("Invalid style reference");
  if (s.subject_data_url && !rasterDataUrl(s.subject_data_url))
    throw new Error("Invalid object reference");
  for (const [value, choices] of [
    [s.workflow, SKETCH_WORKFLOWS],
    [s.output, SKETCH_OUTPUTS],
    [s.material, SKETCH_MATERIALS],
    [s.viewpoint, SKETCH_VIEWS],
  ] as const) {
    if (value !== undefined && !Object.hasOwn(choices, value))
      throw new Error("Invalid sketch workflow settings");
  }
  return {
    ...s,
    scene: {
      ...s.scene,
      // Excalidraw restores unbound elements from null to []; this is not an edit.
      elements: s.scene.elements.map((element) => ({
        ...element,
        boundElements: element.boundElements ?? [],
      })),
    },
  };
}

// Drafts may be incomplete; enforce workflow prerequisites only at generation.
export function sketchWorkflowError(
  s: SketchState,
  hasSource: boolean,
): string | null {
  if (s.workflow === "placement") {
    if (!hasSource) return "Import a scene before placing an object";
    if (!s.subject_data_url) return "Add an object reference";
    if (s.scope !== "region")
      return "Object placement requires selected-area scope";
  }
  if (s.workflow === "viewpoint") {
    if (!hasSource)
      return "Import a source image before proposing another view";
    if (s.scope !== "whole") return "Alternate views require whole-image scope";
  }
  return null;
}
