import jpeg from "jpeg-js";

// High-contrast repeat pattern for texture plumbing, never AI-quality evidence.
export function fixtureMaterial(variant = 0) {
  const width = 256, height = 256, data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, light = (Math.floor(x / 32) + Math.floor(y / 32)) % 2;
    data[i] = light ? 240 : 80; data[i + 1] = light ? 180 : 20 + variant; data[i + 2] = light ? 40 : 150; data[i + 3] = 255;
  }
  return jpeg.encode({ width, height, data }, 90).data;
}
