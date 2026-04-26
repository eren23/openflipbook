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
}

export interface LayoutResult {
  pages: LaidOutPage[];
  connectors: Connector[];
}

const PAGE_W = 1600;
const PAGE_H = 900;
const GAP = 280;
const ROOT_GAP = 600;

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
    });
    placed.push(rect);

    const kids = childrenOf.get(page.nodeId) ?? [];
    for (const kid of kids) {
      const kidRect = positionChild(rect, kid.clickInParent, placed);
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
  placed: WorldRect[]
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

  // Distance from parent center to child center: enough that bounding boxes
  // don't overlap on either axis. Use the larger of the two needed offsets.
  const radius = Math.hypot(PAGE_W, PAGE_H) * 0.55 + GAP;

  // Try base angle first, then nudge ±15° outward up to ±90° each side.
  const tries = [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 135, -135, 180];
  for (const offsetDeg of tries) {
    const ang = baseAngle + (offsetDeg * Math.PI) / 180;
    const ccx = cx + Math.cos(ang) * radius;
    const ccy = cy + Math.sin(ang) * radius;
    const rect: WorldRect = {
      x: ccx - PAGE_W / 2,
      y: ccy - PAGE_H / 2,
      w: PAGE_W,
      h: PAGE_H,
    };
    if (!collidesAny(rect, placed)) return rect;
  }

  // Fallback: stack outward at the base angle even if it overlaps.
  const ang = baseAngle;
  const ccx = cx + Math.cos(ang) * radius * 1.6;
  const ccy = cy + Math.sin(ang) * radius * 1.6;
  return {
    x: ccx - PAGE_W / 2,
    y: ccy - PAGE_H / 2,
    w: PAGE_W,
    h: PAGE_H,
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
