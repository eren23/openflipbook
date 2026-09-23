import { describe, expect, it } from "vitest";

import { STYLE_PRESETS } from "./styles";

// StyleGallery paints `to-black/55` over the bottom of every tile, which is
// where the label sits. So the label is read against the gradient's END colour
// darkened by 55%, not against the gradient itself -- and two presets shipped
// dark labels there, measuring 1.33:1 and 1.49:1.
const OVERLAY = 0.55;
const WCAG_AA = 4.5;

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

function luminance(hex: string): number {
  const [r, g, b] = [0, 1, 2].map((i) => {
    const c = channel(hex, i) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function underLabel(end: string): string {
  const dark = [0, 1, 2].map((i) => Math.floor(channel(end, i) * (1 - OVERLAY)));
  return `#${dark.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("style tiles", () => {
  it.each(STYLE_PRESETS.map((p) => [p.id, p] as const))(
    "%s has a label you can read on its own tile",
    (_id, preset) => {
      expect(contrast(preset.textColor, underLabel(preset.gradient[1]))).toBeGreaterThanOrEqual(WCAG_AA);
    },
  );
});
