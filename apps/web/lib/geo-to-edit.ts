import type { EntityGeoEdit, WorldEntityGeo } from "@openflipbook/config";

/**
 * E4's apply-to-image: a just-applied geo edit plan becomes ONE image-edit
 * instruction for the current page, in the proven repair_instruction register
 * (providers/prompt_library/layout.py — "keep everything else exactly as it
 * is, only adjust: …"). Coordinates moved; now the pixels follow.
 *
 * Pure text building — directions come from the plan's own deltas (world
 * frame is map-aligned: +x east, +y south on a north-up map), magnitudes
 * from the delta relative to the frame. Returns "" for a plan with nothing
 * an image edit can express.
 */

/** Compass phrase for a world-space delta (+x east, +y south). */
export function compassFor(dx: number, dy: number): string {
  const parts: string[] = [];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // Drop the minor axis when it's noise next to the major one.
  if (ay > 0 && ay >= ax * 0.4) parts.push(dy < 0 ? "north" : "south");
  if (ax > 0 && ax >= ay * 0.4) parts.push(dx < 0 ? "west" : "east");
  return parts.join("-") || "in place";
}

function magnitudeFor(dx: number, dy: number, frame: { w: number; h: number }): string {
  const f = Math.max(
    Math.abs(dx) / Math.max(1e-6, frame.w),
    Math.abs(dy) / Math.max(1e-6, frame.h)
  );
  if (f < 0.1) return "slightly ";
  if (f > 0.3) return "far ";
  return "";
}

function labelFor(target: string, entities: WorldEntityGeo[]): string {
  return entities.find((e) => e.id === target)?.label ?? target;
}

function positionPhrase(
  pos: { x: number; y: number },
  frame: { w: number; h: number }
): string {
  const x = pos.x / Math.max(1e-6, frame.w);
  const y = pos.y / Math.max(1e-6, frame.h);
  const h = x < 1 / 3 ? "on the left" : x > 2 / 3 ? "on the right" : "in the center";
  const v = y < 1 / 3 ? "toward the top" : y > 2 / 3 ? "toward the bottom" : "at mid-height";
  return `${h}, ${v} of the frame`;
}

export function applyPlanInstruction(
  edits: EntityGeoEdit[],
  entities: WorldEntityGeo[],
  frame: { w: number; h: number }
): string {
  const parts: string[] = [];
  for (const edit of edits) {
    switch (edit.op) {
      case "move":
        parts.push(
          `move the ${labelFor(edit.target, entities)} ${magnitudeFor(
            edit.dx,
            edit.dy,
            frame
          )}${compassFor(edit.dx, edit.dy)}`
        );
        break;
      case "remove":
        parts.push(`remove the ${labelFor(edit.target, entities)}`);
        break;
      case "add":
        parts.push(`add a ${edit.label} ${positionPhrase(edit.pos, frame)}`);
        break;
      case "set_height": {
        const current = entities.find((e) => e.id === edit.target);
        const taller = !current || edit.height >= current.height;
        parts.push(
          `make the ${labelFor(edit.target, entities)} ${taller ? "taller" : "shorter"}`
        );
        break;
      }
      case "set_appearance":
        parts.push(
          `change the ${labelFor(edit.target, entities)} so it looks like: ${edit.visual}`
        );
        break;
    }
  }
  if (parts.length === 0) return "";
  return (
    "Keep the existing scene, its art medium, colour palette and everything " +
    "else exactly as they are — only adjust: " +
    parts.join("; ") +
    "."
  );
}
