// Azgaar Fantasy Map Generator import: parse the "Export to JSON (full)"
// file into named, positioned places for the world map — so a map made in
// the TTRPG scene's beloved generator becomes an enterable world with the
// RIGHT names at the RIGHT spots, no VLM guessing.
//
// Schema verified against a real v1.149.2 export (2026-08-27):
//   { info: { mapName, width, height, ... },
//     pack: { burgs: [0, {i, name, x, y, capital?, port?, population,
//                         removed?, ...}],
//             states: [{i:0 neutrals}, {i, name, fullName, pole: [x,y]}] } }
// burgs[0] and states[0] are PLACEHOLDERS (0 / neutrals) — skip them.
// x/y are map-pixel coords in the info.width × info.height frame.

import type { WorldEntityGeo } from "@openflipbook/config";

export interface ImportedMapEntity {
  name: string;
  x_pct: number; // 0..1 of the source map frame
  y_pct: number;
  note: string; // one line of provenance ("capital of X, port")
  weight: number; // importance (population + flags) — used to cap the list
}

export interface ParsedAzgaarMap {
  mapName: string;
  entities: ImportedMapEntity[];
}

export const AZGAAR_IMPORT_CAP = 40;

interface AzgaarBurg {
  i?: number;
  name?: string;
  x?: number;
  y?: number;
  capital?: number;
  port?: number;
  population?: number;
  removed?: boolean;
  state?: number;
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Parse an Azgaar full-JSON export. Null when the shape isn't Azgaar's. */
export function parseAzgaarExport(json: unknown): ParsedAzgaarMap | null {
  if (typeof json !== "object" || json === null) return null;
  const doc = json as {
    info?: { mapName?: unknown; width?: unknown; height?: unknown };
    pack?: { burgs?: unknown; states?: unknown };
  };
  const width = Number(doc.info?.width);
  const height = Number(doc.info?.height);
  const burgs = doc.pack?.burgs;
  if (!Number.isFinite(width) || width <= 0) return null;
  if (!Number.isFinite(height) || height <= 0) return null;
  if (!Array.isArray(burgs)) return null;

  const states = Array.isArray(doc.pack?.states)
    ? (doc.pack!.states as { i?: number; fullName?: unknown; name?: unknown }[])
    : [];
  const stateName = (i: number | undefined): string => {
    if (!i) return ""; // state 0 = neutrals
    const s = states.find((st) => st && st.i === i);
    return cleanName(s?.fullName) || cleanName(s?.name);
  };

  const entities: ImportedMapEntity[] = [];
  for (const raw of burgs) {
    // burgs[0] is the literal number 0; removed burgs stay in the array.
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as AzgaarBurg;
    const name = cleanName(b.name);
    if (!name || b.removed) continue;
    const x = Number(b.x);
    const y = Number(b.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const x_pct = x / width;
    const y_pct = y / height;
    if (x_pct < 0 || x_pct > 1 || y_pct < 0 || y_pct > 1) continue;
    const noteParts: string[] = [];
    if (b.capital) {
      const owner = stateName(b.state);
      noteParts.push(owner ? `capital of ${owner}` : "capital");
    }
    if (b.port) noteParts.push("port");
    const pop = Number(b.population);
    entities.push({
      name: name.slice(0, 80),
      x_pct,
      y_pct,
      note: noteParts.join(", "),
      weight:
        (Number.isFinite(pop) ? pop : 0) +
        (b.capital ? 1000 : 0) +
        (b.port ? 10 : 0),
    });
  }
  if (entities.length === 0) return null;
  entities.sort((a, b) => b.weight - a.weight);
  return {
    mapName: cleanName((doc.info as { mapName?: unknown })?.mapName) || "Imported map",
    entities: entities.slice(0, AZGAAR_IMPORT_CAP),
  };
}

// The world-map frame every geo consumer reads (geo-tap MAP_IMAGE_FRAME).
const FRAME_W = 100;
const FRAME_H = 60;

/** Imported entities → world-map geos in the standard map frame. Ids are
 *  deterministic per name so a re-import UPDATES instead of duplicating. */
export function importedEntitiesToGeos(
  entities: ImportedMapEntity[],
  nowIso: string,
): WorldEntityGeo[] {
  return entities.map((e) => {
    const slug = e.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const major = e.weight >= 1000; // capitals read larger on the map
    return {
      id: `geo_import_${slug}`,
      entity_id: null,
      parent_id: null,
      kind: "place",
      label: e.name,
      pos: { x: e.x_pct * FRAME_W, y: e.y_pct * FRAME_H },
      height: major ? 2 : 1,
      footprint: major ? { w: 3, d: 3 } : { w: 2, d: 2 },
      visual: e.note,
      state: {},
      // Author-supplied coordinates from the generator's own data — a USER
      // placement (it wins over later derived/extracted guesses).
      confidence: 1,
      source: "user" as const,
      updated_at: nowIso,
    };
  });
}

/** Server-side body validation for the import route. */
export function validateImportedEntities(
  value: unknown,
): ImportedMapEntity[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > AZGAAR_IMPORT_CAP) return null;
  const out: ImportedMapEntity[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Partial<ImportedMapEntity>;
    const name = cleanName(e.name);
    const x = Number(e.x_pct);
    const y = Number(e.y_pct);
    if (!name || name.length > 80) return null;
    if (!Number.isFinite(x) || x < 0 || x > 1) return null;
    if (!Number.isFinite(y) || y < 0 || y > 1) return null;
    out.push({
      name,
      x_pct: x,
      y_pct: y,
      note: cleanName(e.note).slice(0, 120),
      weight: Number.isFinite(Number(e.weight)) ? Number(e.weight) : 0,
    });
  }
  return out;
}
