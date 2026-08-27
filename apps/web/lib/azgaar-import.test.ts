import { describe, expect, it } from "vitest";

import fixture from "./azgaar-fixture.json";
import {
  AZGAAR_IMPORT_CAP,
  importedEntitiesToGeos,
  parseAzgaarExport,
  validateImportedEntities,
} from "./azgaar-import";

describe("parseAzgaarExport (real v1.149.2 fixture)", () => {
  it("parses burgs into frame-relative entities, capitals first", () => {
    const parsed = parseAzgaarExport(fixture);
    expect(parsed).not.toBeNull();
    expect(parsed!.mapName).toBe("Bones");
    // burgs[0] placeholder + the removed burg are skipped: 4 real burgs.
    expect(parsed!.entities).toHaveLength(4);
    // Chawleigh: biggest capital first, coords normalized by info.width/height.
    const first = parsed!.entities[0]!;
    expect(first.name).toBe("Chawleigh");
    expect(first.x_pct).toBeCloseTo(50.67 / 1164, 5);
    expect(first.y_pct).toBeCloseTo(586.24 / 1157, 5);
    expect(first.note).toBe("capital of Kingdom of Chawleigh, port");
    // Ely: a plain town — no note, sorted after the capitals.
    const ely = parsed!.entities.find((e) => e.name === "Ely")!;
    expect(ely.note).toBe("");
    expect(parsed!.entities.indexOf(ely)).toBe(3);
  });

  it("rejects non-Azgaar shapes", () => {
    expect(parseAzgaarExport(null)).toBeNull();
    expect(parseAzgaarExport({})).toBeNull();
    expect(parseAzgaarExport({ info: { width: 100 } })).toBeNull();
    expect(
      parseAzgaarExport({ info: { width: 100, height: 100 }, pack: { burgs: [0] } }),
    ).toBeNull();
  });

  it("caps a burg flood at the import cap, keeping the important ones", () => {
    const burgs: unknown[] = [0];
    for (let i = 1; i <= 80; i++) {
      burgs.push({ i, name: `Town ${i}`, x: i, y: i, population: i });
    }
    const parsed = parseAzgaarExport({
      info: { width: 100, height: 100 },
      pack: { burgs },
    })!;
    expect(parsed.entities).toHaveLength(AZGAAR_IMPORT_CAP);
    expect(parsed.entities[0]!.name).toBe("Town 80"); // biggest population
  });
});

describe("importedEntitiesToGeos", () => {
  it("maps pct coords into the 100x60 map frame with deterministic ids", () => {
    const geos = importedEntitiesToGeos(
      parseAzgaarExport(fixture)!.entities.slice(0, 2),
      "2026-08-27T00:00:00.000Z",
    );
    expect(geos[0]!.id).toBe("geo_import_chawleigh");
    expect(geos[0]!.pos.x).toBeCloseTo((50.67 / 1164) * 100, 4);
    expect(geos[0]!.pos.y).toBeCloseTo((586.24 / 1157) * 60, 4);
    expect(geos[0]!.kind).toBe("place");
    expect(geos[0]!.footprint).toEqual({ w: 3, d: 3 }); // a capital reads larger
    // Re-import stability: same name -> same id.
    const again = importedEntitiesToGeos(
      parseAzgaarExport(fixture)!.entities.slice(0, 2),
      "2026-08-27T00:00:00.000Z",
    );
    expect(again[0]!.id).toBe(geos[0]!.id);
  });
});

describe("validateImportedEntities", () => {
  const good = [{ name: "Chawleigh", x_pct: 0.1, y_pct: 0.9, note: "", weight: 1 }];

  it("accepts a clean list", () => {
    expect(validateImportedEntities(good)).toHaveLength(1);
  });

  it.each([
    ["empty", []],
    ["not a list", { name: "x" }],
    ["missing name", [{ x_pct: 0.5, y_pct: 0.5 }]],
    ["coords out of range", [{ name: "A", x_pct: 1.5, y_pct: 0.5 }]],
    ["oversized name", [{ name: "a".repeat(90), x_pct: 0.5, y_pct: 0.5 }]],
    ["over the cap", Array.from({ length: 41 }, (_, i) => ({ name: `T${i}`, x_pct: 0.5, y_pct: 0.5 }))],
  ])("rejects %s", (_name, value) => {
    expect(validateImportedEntities(value)).toBeNull();
  });
});
