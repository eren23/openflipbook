/**
 * The truth half of the silhouette gate: render the stored footprints from
 * each camera of a saved route and write one raw 0/1 mask per named building.
 * `silhouette_runner.py` then asks a segmenter what is actually painted in the
 * same spot and compares. Split because the renderer lives in TypeScript and
 * the paid segmenter call lives with the other bench runners.
 *
 *   npx tsx silhouette_masks.ts <entities.json> <route.json> <out-dir> [laneGap]
 *
 * `laneGap` must match whatever the frames were painted with, or the truth is
 * a different town from the one in the picture.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderLayoutControl } from "../../../web/lib/layout-control";
import { maskForVisible, maskStats } from "../../../web/lib/silhouette";

const [entitiesPath, routePath, outDir, gapArg] = process.argv.slice(2);
const gap = Number(gapArg ?? 7);
const entities = JSON.parse(readFileSync(entitiesPath!, "utf8"));
const route = JSON.parse(readFileSync(routePath!, "utf8"));
mkdirSync(outDir!, { recursive: true });
const W = route.width, H = route.height;

const out: unknown[] = [];
for (const shot of route.shots) {
  const c = renderLayoutControl(entities, shot.observer, W, H, null, gap);
  const rows = c.visible.map((v, k) => {
    const mask = maskForVisible(c.ids, k);
    const st = maskStats(mask, W, H)!;
    writeFileSync(join(outDir!, `cam${shot.index}_${k}.mask`), Buffer.from(mask));
    return { k, label: v.label, pixels: v.pixels, width: +st.width.toFixed(4), cx: +st.cx.toFixed(4), cy: +st.cy.toFixed(4) };
  });
  out.push({ camera: shot.index, width: W, height: H, visible: rows });
}
writeFileSync(join(outDir!, "masks.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.slice(0, 3), null, 1));
