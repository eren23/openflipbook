import type { NodeRelation, ScaleKind } from "@openflipbook/config";

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidOutPage {
  nodeId: string;
  rect: WorldRect;
  imageDataUrl: string | null;
  title: string;
  parentId: string | null;
  /** World-coord point on the parent's rect where the user clicked. Null for roots. */
  parentClickPoint: { x: number; y: number } | null;
  /** M3 scale-space: how this node relates to its parent + its relative size,
   *  so the atlas can render expand-neighbours / scale distinctly. */
  relation?: NodeRelation;
  scale?: ScaleKind;
}

export interface Connector {
  fromNodeId: string;
  toNodeId: string;
  /** World point on the parent at the click location. */
  from: { x: number; y: number };
  /** World point on the child's edge nearest the parent. */
  to: { x: number; y: number };
}

export interface LayoutInput {
  nodeId: string;
  parentId: string | null;
  imageDataUrl: string | null;
  title: string;
  clickInParent?: { xPct: number; yPct: number };
  relation?: NodeRelation;
  scale?: ScaleKind;
}

export interface LayoutResult {
  pages: LaidOutPage[];
  connectors: Connector[];
}

const PAGE_W = 1600;
const PAGE_H = 900;
const GAP = 280;
const ROOT_GAP = 600;

/** Rect size relative to a peer/default node — containers loom larger, parts
 *  shrink. `undefined`/`peer` returns 1.0 so scale-less nodes are unchanged. */
function sizeFactor(scale?: ScaleKind): number {
  if (scale === "container") return 1.5;
  if (scale === "component") return 0.6;
  return 1.0;
}

/** Multiplier on the parent→child radius — bigger things sit farther out
 *  (pan out to reach), smaller things nearer (zoom in). 1.0 for peer/default. */
function radiusBias(scale?: ScaleKind): number {
  if (scale === "container") return 1.5;
  if (scale === "component") return 0.85;
  return 1.0;
}

/**
 * Lay pages out as a branching land. Each child sits outside its parent
 * in the direction of the click, same size as the parent, with a connector
 * from the click point to the child's near edge.
 *
 * Sibling collision avoidance: if a child would land on top of an already-
 * placed sibling, fan it out angularly around the parent's center until it
 * fits.
 */
export function layoutPages(pages: LayoutInput[]): LayoutResult {
  const byId = new Map<string, LayoutInput>();
  for (const p of pages) byId.set(p.nodeId, p);

  const childrenOf = new Map<string | null, LayoutInput[]>();
  for (const p of pages) {
    const key = p.parentId && byId.has(p.parentId) ? p.parentId : null;
    const arr = childrenOf.get(key) ?? [];
    arr.push(p);
    childrenOf.set(key, arr);
  }

  const out: LaidOutPage[] = [];
  const connectors: Connector[] = [];
  const placed: WorldRect[] = [];

  const place = (
    page: LayoutInput,
    rect: WorldRect,
    parentRect: WorldRect | null
  ) => {
    out.push({
      nodeId: page.nodeId,
      rect,
      imageDataUrl: page.imageDataUrl,
      title: page.title,
      parentId: page.parentId ?? null,
      parentClickPoint:
        parentRect && page.clickInParent
          ? {
              x: parentRect.x + page.clickInParent.xPct * parentRect.w,
              y: parentRect.y + page.clickInParent.yPct * parentRect.h,
            }
          : null,
      ...(page.relation ? { relation: page.relation } : {}),
      ...(page.scale ? { scale: page.scale } : {}),
    });
    placed.push(rect);

    const kids = childrenOf.get(page.nodeId) ?? [];
    for (const kid of kids) {
      const kidRect = positionChild(rect, kid.clickInParent, placed, kid.scale);
      if (kid.clickInParent) {
        const clickWorld = {
          x: rect.x + kid.clickInParent.xPct * rect.w,
          y: rect.y + kid.clickInParent.yPct * rect.h,
        };
        const edge = nearestEdgePoint(kidRect, clickWorld);
        connectors.push({
          fromNodeId: page.nodeId,
          toNodeId: kid.nodeId,
          from: clickWorld,
          to: edge,
        });
      }
      place(kid, kidRect, rect);
    }
  };

  const roots = childrenOf.get(null) ?? [];
  let cursorX = 0;
  for (const root of roots) {
    const rect: WorldRect = { x: cursorX, y: 0, w: PAGE_W, h: PAGE_H };
    place(root, rect, null);
    cursorX += PAGE_W + ROOT_GAP;
  }

  return { pages: out, connectors };
}

/**
 * Place a child outside its parent, in the direction of the click.
 * If the slot collides with already-placed pages, rotate the angle
 * until a clear slot is found.
 */
function positionChild(
  parent: WorldRect,
  click: { xPct: number; yPct: number } | undefined,
  placed: WorldRect[],
  scale?: ScaleKind
): WorldRect {
  const cx = parent.x + parent.w / 2;
  const cy = parent.y + parent.h / 2;

  let baseAngle: number;
  if (click) {
    const dx = click.xPct - 0.5;
    const dy = click.yPct - 0.5;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
      baseAngle = 0;
    } else {
      baseAngle = Math.atan2(dy, dx);
    }
  } else {
    // Roots without a click — fan to the right by default.
    baseAngle = 0;
  }

  // Child size from scale: containers loom larger, components shrink.
  const childW = PAGE_W * sizeFactor(scale);
  const childH = PAGE_H * sizeFactor(scale);
  // Distance from parent center to child center. For a peer/default child this
  // equals the original radius (back-compat); it grows with child size so a
  // bigger child still clears, and is biased by scale so bigger things sit
  // farther out and smaller things nearer — the scale gradient.
  const radius =
    (Math.hypot(PAGE_W, PAGE_H) + Math.hypot(childW, childH)) * 0.275 * radiusBias(scale) +
    GAP;

  // Try base angle first, then nudge ±15° outward up to ±90° each side.
  const tries = [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 135, -135, 180];
  for (const offsetDeg of tries) {
    const ang = baseAngle + (offsetDeg * Math.PI) / 180;
    const ccx = cx + Math.cos(ang) * radius;
    const ccy = cy + Math.sin(ang) * radius;
    const rect: WorldRect = {
      x: ccx - childW / 2,
      y: ccy - childH / 2,
      w: childW,
      h: childH,
    };
    if (!collidesAny(rect, placed)) return rect;
  }

  // Fallback: stack outward at the base angle even if it overlaps.
  const ang = baseAngle;
  const ccx = cx + Math.cos(ang) * radius * 1.6;
  const ccy = cy + Math.sin(ang) * radius * 1.6;
  return {
    x: ccx - childW / 2,
    y: ccy - childH / 2,
    w: childW,
    h: childH,
  };
}

function rectsOverlap(a: WorldRect, b: WorldRect): boolean {
  // Treat rects as overlapping if their bounding boxes intersect with a
  // small inset (so tiles don't kiss).
  const pad = 40;
  return (
    a.x + pad < b.x + b.w &&
    a.x + a.w > b.x + pad &&
    a.y + pad < b.y + b.h &&
    a.y + a.h > b.y + pad
  );
}

function collidesAny(rect: WorldRect, placed: WorldRect[]): boolean {
  for (const p of placed) if (rectsOverlap(rect, p)) return true;
  return false;
}

function nearestEdgePoint(
  rect: WorldRect,
  point: { x: number; y: number }
): { x: number; y: number } {
  // Project point onto the rect's edge nearest to it.
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  if (Math.abs(dx) * rect.h > Math.abs(dy) * rect.w) {
    // Hit a vertical edge.
    const ex = dx > 0 ? rect.x : rect.x + rect.w;
    const ey = cy + (dy * (rect.w / 2)) / Math.max(Math.abs(dx), 0.001);
    return { x: ex, y: ey };
  }
  const ey = dy > 0 ? rect.y : rect.y + rect.h;
  const ex = cx + (dx * (rect.h / 2)) / Math.max(Math.abs(dy), 0.001);
  return { x: ex, y: ey };
}

/**
 * SVG cubic-bezier `d` attribute connecting two world points, with a
 * perpendicular bend so parallel connectors don't read as a single straight
 * line. Extracted from atlas-view.tsx so the same arc geometry can be
 * shared with future overlays (and unit-tested).
 */
export function arcPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  // Degenerate (same point): emit a zero-length curve. Still a valid SVG path.
  if (len < 1e-3) {
    return `M ${from.x} ${from.y} C ${from.x} ${from.y}, ${from.x} ${from.y}, ${to.x} ${to.y}`;
  }
  const px = -dy / len;
  const py = dx / len;
  const bend = len * 0.18;
  const c1x = from.x + dx * 0.33 + px * bend;
  const c1y = from.y + dy * 0.33 + py * bend;
  const c2x = from.x + dx * 0.67 - px * bend;
  const c2y = from.y + dy * 0.67 - py * bend;
  return `M ${from.x} ${from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.x} ${to.y}`;
}

/**
 * Per-depth visual tint that lets the atlas read as a layered scene without
 * any per-node colorimetry: deeper nodes are slightly less saturated and
 * less opaque, so the focused / root area pops. Clamped so very deep paths
 * stay legible.
 */
export function depthTint(depth: number): { saturation: number; opacity: number } {
  const d = Math.max(0, depth);
  // Saturation drops by 0.08 per level, floored at 0.5.
  const saturation = Math.max(0.5, 1 - 0.08 * d);
  // Opacity drops by 0.05 per level, floored at 0.6.
  const opacity = Math.max(0.6, 1 - 0.05 * d);
  return { saturation, opacity };
}

/**
 * Scale bucket → integer step on the scale ladder, relative to the parent.
 * A container is one level *up* (bigger / zoom-out), a component one level
 * *down* (smaller / zoom-in), a peer/scale-less node stays level (0). BFS over
 * the tree (parentLevel + scaleStep(child)) yields each node's absolute level.
 */
export function scaleStep(scale?: ScaleKind): number {
  if (scale === "container") return 1;
  if (scale === "component") return -1;
  return 0;
}

/**
 * Level-of-detail visibility for a node at absolute `scaleLevel`, given the
 * camera `zoom` and the map's fit-all `fitZoom`. Each scale-level owns a band
 * of zoom (measured in octaves = log2 zoom ratio): bigger things (higher
 * level) are centred when zoomed *out*, smaller things (lower level) when
 * zoomed *in*. Inside the band → fully visible (1); outside it fades linearly
 * to a floor so a node never vanishes entirely (the map stays legible). Peers
 * (level 0) peak at the fit-all zoom. This is the "small stuff reveals when
 * you zoom in" payoff; callers gate it off when a session has no scale spread.
 */
export function lodOpacity(
  scaleLevel: number,
  zoom: number,
  fitZoom: number
): number {
  const SPREAD = 1.4; // octaves of zoom per scale-level
  const BAND = 1.2; // half-width of the full-opacity plateau (octaves)
  const FEATHER = 1.6; // fade distance beyond the band (octaves)
  const FLOOR = 0.12; // never fully hide — keep the map readable
  const octave = Math.log2(Math.max(zoom, 1e-6) / Math.max(fitZoom, 1e-6));
  const center = -SPREAD * scaleLevel;
  const dist = Math.abs(octave - center);
  if (dist <= BAND) return 1;
  return Math.max(FLOOR, 1 - (dist - BAND) / FEATHER);
}

/**
 * Compute camera (cx, cy, zoom) that fits `rect` in a viewport of size
 * (vw, vh) with `padding` fraction of slack (0.1 = 10% margin around).
 */
export function fitCamera(
  rect: WorldRect,
  vw: number,
  vh: number,
  padding: number = 0.12
): { cx: number; cy: number; zoom: number } {
  const slack = 1 - padding;
  const zoomX = (vw * slack) / rect.w;
  const zoomY = (vh * slack) / rect.h;
  return {
    cx: rect.x + rect.w / 2,
    cy: rect.y + rect.h / 2,
    zoom: Math.min(zoomX, zoomY),
  };
}

/**
 * Camera that fits the union of all rects.
 */
export function fitAllCamera(
  pages: LaidOutPage[],
  vw: number,
  vh: number
): { cx: number; cy: number; zoom: number } {
  if (pages.length === 0) return { cx: 0, cy: 0, zoom: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pages) {
    minX = Math.min(minX, p.rect.x);
    minY = Math.min(minY, p.rect.y);
    maxX = Math.max(maxX, p.rect.x + p.rect.w);
    maxY = Math.max(maxY, p.rect.y + p.rect.h);
  }
  return fitCamera(
    { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    vw,
    vh
  );
}
