// Client-only image export helpers (canvas/Blob) shared by the play-page
// context menu (raw image + copy) and the WorldMiniMap PNG export. Callers are
// all "use client"; every function here touches the DOM/canvas.

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has claimed the URL, not before.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A serialized SVG needs the xmlns declaration or `new Image()` refuses the
 *  data URL. Pure string work — the one part of the rasterizer worth testing
 *  without a canvas. Idempotent: never adds a second xmlns. */
export function ensureSvgXmlns(source: string): string {
  if (source.includes('xmlns="http://www.w3.org/2000/svg"')) return source;
  return source.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

/** Rasterize a pure-vector inline SVG element to a PNG Blob at `scale`× its
 *  pixel size. For SVGs with no external <image>/font refs (the WorldMiniMap) —
 *  those would taint the canvas or drop from the raster. */
export async function svgElementToPngBlob(
  svg: SVGSVGElement,
  scale = 3,
  background = "#fafaf9",
): Promise<Blob> {
  const w =
    svg.width.baseVal.value || Number(svg.getAttribute("width")) || svg.clientWidth;
  const h =
    svg.height.baseVal.value || Number(svg.getAttribute("height")) || svg.clientHeight;
  const source = ensureSvgXmlns(new XMLSerializer().serializeToString(svg));
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("svg rasterize: image load failed"));
    img.src = svgUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("svg rasterize: no 2d context");
  // The SVG is transparent; paint the card's ground so it reads on any viewer.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("svg rasterize: toBlob returned null");
  return blob;
}

/** Re-encode an image Blob (e.g. a same-origin JPEG) as PNG — the format the
 *  Clipboard API accepts for image writes. The input must be same-origin or the
 *  canvas taints and toBlob throws. */
export async function rasterToPngBlob(input: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(input);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("copy image: no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!png) throw new Error("copy image: toBlob returned null");
  return png;
}
