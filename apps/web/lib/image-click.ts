export interface NormalizedClick {
  x_pct: number;
  y_pct: number;
}

/**
 * Convert a raw mouse event on an <img> into a percent offset into the
 * image's intrinsic pixel grid. Handles object-fit: contain letterboxing.
 */
export function normalizeClickOnImage(
  event: MouseEvent,
  img: HTMLImageElement
): NormalizedClick | null {
  if (!img.naturalWidth || !img.naturalHeight) return null;

  const rect = img.getBoundingClientRect();
  const boxWidth = rect.width;
  const boxHeight = rect.height;
  if (boxWidth <= 0 || boxHeight <= 0) return null;

  const naturalAspect = img.naturalWidth / img.naturalHeight;
  const boxAspect = boxWidth / boxHeight;

  let renderedWidth = boxWidth;
  let renderedHeight = boxHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (naturalAspect > boxAspect) {
    renderedHeight = boxWidth / naturalAspect;
    offsetY = (boxHeight - renderedHeight) / 2;
  } else {
    renderedWidth = boxHeight * naturalAspect;
    offsetX = (boxWidth - renderedWidth) / 2;
  }

  const localX = event.clientX - rect.left - offsetX;
  const localY = event.clientY - rect.top - offsetY;

  if (
    localX < 0 ||
    localY < 0 ||
    localX > renderedWidth ||
    localY > renderedHeight
  ) {
    return null;
  }

  return {
    x_pct: clamp01(localX / renderedWidth),
    y_pct: clamp01(localY / renderedHeight),
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Draw a red crosshair at (xPct, yPct) on a copy of `dataUrl` and return
 * the annotated JPEG as a data URL. Used to give the VLM an unambiguous
 * visual reference to the click point — numeric "x=0.47,y=0.62" text
 * hints are wildly imprecise for current open-weights VLMs.
 */
export async function annotateClickPoint(
  dataUrl: string,
  xPct: number,
  yPct: number
): Promise<string> {
  const img = new Image();
  img.decoding = "async";
  img.src = dataUrl;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;

  ctx.drawImage(img, 0, 0);

  const x = xPct * canvas.width;
  const y = yPct * canvas.height;
  const r = Math.max(24, Math.round(canvas.width * 0.02));
  const reach = r * 1.8;

  // White halo so the marker stays visible on any background.
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - reach, y);
  ctx.lineTo(x + reach, y);
  ctx.moveTo(x, y - reach);
  ctx.lineTo(x, y + reach);
  ctx.stroke();

  // Red on top of the halo.
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - reach, y);
  ctx.lineTo(x + reach, y);
  ctx.moveTo(x, y - reach);
  ctx.lineTo(x, y + reach);
  ctx.stroke();

  // Small filled centre dot.
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(x, y, Math.max(3, r * 0.18), 0, Math.PI * 2);
  ctx.fill();

  return canvas.toDataURL("image/jpeg", 0.92);
}
