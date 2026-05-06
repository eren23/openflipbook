export interface NormalizedClick {
  x_pct: number;
  y_pct: number;
}

export interface NormalizedStroke {
  points: NormalizedClick[];
  bbox: { x: number; y: number; w: number; h: number };
  centroid: NormalizedClick;
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

/** Compute centroid + bbox from a list of normalized stroke points. */
export function summarizeStroke(points: NormalizedClick[]): NormalizedStroke | null {
  if (points.length < 2) return null;
  let minX = 1,
    minY = 1,
    maxX = 0,
    maxY = 0,
    sumX = 0,
    sumY = 0;
  for (const p of points) {
    if (p.x_pct < minX) minX = p.x_pct;
    if (p.y_pct < minY) minY = p.y_pct;
    if (p.x_pct > maxX) maxX = p.x_pct;
    if (p.y_pct > maxY) maxY = p.y_pct;
    sumX += p.x_pct;
    sumY += p.y_pct;
  }
  return {
    points,
    bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    centroid: {
      x_pct: clamp01(sumX / points.length),
      y_pct: clamp01(sumY / points.length),
    },
  };
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

/**
 * Draw the user's stroke (Shift+drag scribble) onto a copy of `dataUrl` so
 * the VLM sees the circled / underlined region directly. Rendered as a red
 * polyline with a white halo for contrast on any background. The stroke's
 * centroid is used as the click point — that's what `annotateClickPoint`
 * already understands — so the existing resolver wakes up with both a
 * crosshair AND the stroke shape pointing at the same subject.
 */
export async function annotateStroke(
  dataUrl: string,
  stroke: NormalizedStroke
): Promise<string> {
  if (!stroke || stroke.points.length < 2) return dataUrl;
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

  const path = new Path2D();
  const first = stroke.points[0]!;
  path.moveTo(first.x_pct * canvas.width, first.y_pct * canvas.height);
  for (let i = 1; i < stroke.points.length; i++) {
    const p = stroke.points[i]!;
    path.lineTo(p.x_pct * canvas.width, p.y_pct * canvas.height);
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // White halo first.
  ctx.lineWidth = 14;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.stroke(path);
  // Red on top.
  ctx.lineWidth = 7;
  ctx.strokeStyle = "#ef4444";
  ctx.stroke(path);

  // Crosshair at the centroid so the VLM still has its anchor point.
  const cx = stroke.centroid.x_pct * canvas.width;
  const cy = stroke.centroid.y_pct * canvas.height;
  const r = Math.max(18, Math.round(canvas.width * 0.015));
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  return canvas.toDataURL("image/jpeg", 0.92);
}
