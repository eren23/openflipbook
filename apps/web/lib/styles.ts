export interface StylePreset {
  id: string;
  name: string;
  /** Short style descriptor concatenated into the page-generation prompt. */
  promptFragment: string;
  /** Two-stop CSS linear-gradient pair for the tile background. */
  gradient: [string, string];
  /** Text color over the tile background — accessibility-tuned per preset. */
  textColor: string;
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: "storybook",
    name: "Storybook",
    promptFragment:
      "hand-painted children's storybook illustration, soft warm palette, gentle ink outlines, rounded forms, naïve perspective",
    gradient: ["#4a6b8a", "#2a4666"],
    textColor: "#ffffff",
  },
  {
    id: "woodcut",
    name: "Woodcut",
    promptFragment:
      "hand-carved woodcut print, high-contrast black ink on cream paper, expressive line work, visible chisel grain",
    gradient: ["#d4a574", "#8b6f47"],
    textColor: "#2a1a0a",
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    promptFragment:
      "neon cyberpunk illustration, rain-slick streets, magenta and cyan rim light, holographic signage, gritty texture",
    gradient: ["#2a1a3a", "#5a1a4a"],
    textColor: "#ff66cc",
  },
  {
    id: "vintage",
    name: "Vintage",
    promptFragment:
      "early-20th-century lithograph plate, muted pastel ink, cross-hatching, slight halftone screen, aged paper",
    gradient: ["#e8c4a0", "#c8a474"],
    textColor: "#4a2a0a",
  },
  {
    id: "botanical",
    name: "Botanical",
    promptFragment:
      "antique botanical-plate illustration, fine pen and watercolor wash, scientific labels, calm green-gold palette",
    gradient: ["#1a3a1a", "#4a6a4a"],
    textColor: "#ffffff",
  },
  {
    id: "comic",
    name: "Comic",
    promptFragment:
      "bold western-comic-book panel, thick inked outlines, flat saturated color fills, halftone dot shading, snappy composition",
    gradient: ["#c8302a", "#5a1a14"],
    textColor: "#ffffff",
  },
  {
    id: "noir",
    name: "Noir",
    promptFragment:
      "film-noir illustration, dramatic chiaroscuro lighting, deep blacks, smoke and rain, monochrome with a single accent color",
    gradient: ["#1a1a1a", "#4a4a4a"],
    textColor: "#ffffff",
  },
  {
    id: "pixel",
    name: "Pixel",
    promptFragment:
      "16-bit pixel-art scene, limited palette, dithered shading, crisp 1-pixel outlines, isometric or side-on composition",
    gradient: ["#2a4a8a", "#1a2a5a"],
    textColor: "#66ffaa",
  },
];

export const PRESET_ANCHOR_PREFIX = "preset:";

export function getStylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id);
}

/**
 * Synthetic `StyleAnchor.nodeId` used when a preset is the active style.
 * Real page nodeIds never collide because they're UUIDs.
 */
export function presetNodeId(presetId: string): string {
  return `${PRESET_ANCHOR_PREFIX}${presetId}`;
}

export function isPresetAnchor(nodeId: string): boolean {
  return nodeId.startsWith(PRESET_ANCHOR_PREFIX);
}
