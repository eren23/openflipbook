import * as THREE from "three";

export function stoneTexture(width: number, depth: number) {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  if (!ctx) return null;
  canvas.width = canvas.height = 512;
  ctx.fillStyle = "#747f79"; ctx.fillRect(0, 0, 512, 512);
  // Fixed masonry pattern: revisiting a scene never randomizes its surface.
  for (let row = 0; row < 16; row++) for (let col = -1; col < 9; col++) {
    const x = col * 64 + row % 2 * 32, y = row * 32;
    const shade = 144 + ((row * 17 + col * 29 + 71) % 23);
    ctx.fillStyle = `rgb(${shade},${shade + 5},${shade - 3})`;
    ctx.fillRect(x + 2, y + 2, 60, 28);
    ctx.strokeStyle = "#bac0b14f"; ctx.strokeRect(x + 4, y + 4, 56, 24);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(width / 4, depth / 4);
  texture.anisotropy = 4;
  return texture;
}
