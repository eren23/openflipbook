import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { exploreWorld } from "./demo-exploration.mjs";

const base = "http://127.0.0.1:3003";
const output = resolve(process.argv[2] || "../../docs/research/assets/map-roundtrip-uncut-2026-09-11");
// A fresh directory prevents stale review decisions from accepting a new take.
await mkdir(output, { recursive: false });
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: base, viewport: { width: 1600, height: 1000 }, recordVideo: { dir: output, size: { width: 1600, height: 1000 } } });
const page = await context.newPage(), video = page.video(), events = [], errors = [];
page.setDefaultTimeout(60_000);
const started = Date.now(), event = name => { const e = { name, seconds: (Date.now() - started) / 1000 }; events.push(e); console.log(JSON.stringify(e)); };
const pause = ms => page.waitForTimeout(ms), click = async (name, role = "button") => { await page.getByRole(role, { name, exact: true }).click(); await pause(650); };
const field = async (name, value) => { await page.getByRole("spinbutton", { name, exact: true }).fill(String(value)); await pause(550); };
const json = async url => { const r = await page.request.get(url); if (!r.ok()) throw new Error(`Read failed: ${r.status()}`); return r.json(); };
const ready = async n => { const views = page.getByTestId("place-viewport"); await expect(views).toHaveCount(n); for (const v of await views.all()) await expect(v).toHaveAttribute("data-ready", "true"); };
let status = "failed", calls = 0, source, saved, kept, checks, draftId, exploration;
const full = process.env.FULL_EXPLORATION === "1";
page.on("pageerror", e => errors.push(e.message));
// Real provider requests only, with an explicit upper bound for a failed visual take.
await page.route("**/api/generate-page", r => { calls++; if (calls > (full ? 5 : 2)) { errors.push("Generation-submission ceiling exceeded"); return r.abort(); } return r.continue(); });
try {
  await page.goto("/sketch/world/ankh");
  await expect(page.getByRole("img", { name: "Ankh-Morpork city map" })).toBeVisible();
  event("map"); await pause(2200);
  await click("Focus Mended Drum"); await pause(1600);
  await click("Enter the Drum's street"); event("street"); await pause(2600);
  await click("Save to world"); await page.waitForURL("**/sketch/world?**"); await ready(1);
  source = new URL(page.url()).searchParams.get("source");
  await page.getByRole("checkbox", { name: "Confirm authored dimensions" }).check(); await pause(600);
  await click("Preview"); await pause(900); await click("Apply to world");
  await expect(page.getByRole("status")).toHaveText("Revision 1 · Saved");
  await click("Plan + 3D"); await ready(2); event("authored_geometry"); await pause(1800);
  const contextUrl = `/api/world/scene-context?source=${source}`, initial = await json(contextUrl);
  const beforeMap = await json(`/api/world/${initial.session_id}/map`);
  await click("The Mended Drum tavern"); await click("Frame selected in 3D"); await pause(1500);
  await field("Object width", 9.4); await ready(2);
  await field("Object height", 9.6); await ready(2);
  await click("teal roof"); await ready(2); event("building_edited"); await pause(1800);
  await page.getByRole("combobox", { name: "Component type", exact: true }).selectOption("house"); await pause(550);
  await click("Draw footprint");
  const box = await page.getByRole("region", { name: "Live plan", exact: true }).locator("canvas").boundingBox();
  const half = Math.max(13, 21 * box.height / box.width);
  const point = (x, z) => ({ x: box.x + box.width / 2 + (x - 20) * box.height / (2 * half), y: box.y + box.height / 2 + (z - 12) * box.height / (2 * half) });
  const a = point(21, 13), b = point(24, 16);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= 40; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / 40, a.y + (b.y - a.y) * i / 40); await pause(35); }
  await pause(600); await page.mouse.up(); await ready(2); event("footprint_drawn");
  await page.getByRole("textbox", { name: "Object name" }).fill("Filigree workshop"); await pause(600);
  for (const [key, value] of [["x", 22.5], ["z", 14.5], ["width", 3], ["depth", 3], ["height", 4]]) await field(`Object ${key}`, value);
  await ready(2); await click("Frame selected in 3D"); await pause(1800);
  const orbit = await page.getByRole("region", { name: "Live 3D", exact: true }).locator("canvas").boundingBox().catch(() => null);
  if (orbit) {
    await page.mouse.move(orbit.x + orbit.width * 0.55, orbit.y + orbit.height * 0.5); await page.mouse.down();
    for (let i = 1; i <= 36; i++) { await page.mouse.move(orbit.x + orbit.width * (0.55 + 0.14 * i / 36), orbit.y + orbit.height * (0.5 + 0.035 * i / 36)); await pause(30); }
    await page.mouse.up(); await pause(1000);
  }
  expect(await json(`/api/world/${initial.session_id}/map`)).toEqual(beforeMap);
  await click("Preview"); event("geometry_review"); await pause(1800); await click("Apply to world");
  await expect(page.getByRole("status")).toHaveText("Revision 2 · Saved"); await ready(2);
  saved = await json(contextUrl); const savedMap = await json(`/api/world/${initial.session_id}/map`);
  event("geometry_saved"); await pause(1600);
  await click("Repaint map artwork", "link");
  await expect(page.getByRole("img", { name: "Current parent map artwork" })).toBeVisible();
  for (const [name, value] of [["x", 45.2], ["y", 59.3], ["width", 10.3]]) await field(`Map ${name}`, value);
  event("map_registered"); await pause(2500);
  await page.getByRole("checkbox", { name: "Map placement reviewed (approximate)" }).check(); await pause(850);
  await click("Open repaint in Sketch"); await page.waitForURL("**/sketch?id=**"); draftId = new URL(page.url()).searchParams.get("id");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  const prompt = page.getByRole("textbox", { name: "Your changes" });
  await prompt.fill(await prompt.inputValue() + "\nRender BOTH requested buildings: the large tavern roof is muted teal, and the separate NEW workshop to its right has a dusty-oxblood tiled roof, like nearby tiny houses. The workshop must be visible, not replaced by trees or blank ground. All bright blue/cyan rectangular borders are annotation guides: remove their strokes entirely, replacing them with sepia parchment and paths, while retaining both new roof shapes. No blue outline boxes in the finished map.");
  await pause(1400); event("sketch_guide"); await page.screenshot({ path: `${output}/guide.png` });
  for (let attempt = 1; attempt <= 2; attempt++) {
    event(`generation_${attempt}_start`);
    const response = page.waitForResponse(r => r.url().endsWith("/api/generate-page") && r.request().method() === "POST", { timeout: 780_000 });
    await click(attempt === 1 ? "Generate" : "Generate Another");
    const result = await (await response).json();
    if (!result.candidate?.image_url || result.candidate.mock || result.candidate.outside_changed !== 0) throw new Error(`Unusable candidate: ${result.error || JSON.stringify(result.candidate)}`);
    await expect(page.getByRole("button", { name: "Keep Version" })).toBeEnabled();
    await expect.poll(() => page.getByRole("img", { name: "Generated candidate" }).evaluate(i => i.naturalWidth)).toBe(1672);
    event(`generation_${attempt}_ready`);
    const image = await page.request.get(result.candidate.image_url);
    await writeFile(`${output}/candidate-${attempt}.png`, await image.body());
    const slider = page.getByRole("slider", { name: "Before and after comparison" });
    await slider.focus(); await page.keyboard.press("Home"); await pause(1800);
    await page.screenshot({ path: `${output}/review-${attempt}.png` });
    await writeFile(`${output}/pending-review.json`, JSON.stringify({ attempt, draftId, source, candidate: result.candidate, output }, null, 2));
    event(`awaiting_visual_review_${attempt}`);
    let decision;
    for (let i = 0; i < 240; i++) { try { decision = JSON.parse(await readFile(`${output}/decision-${attempt}.json`, "utf8")); break; } catch { await pause(1000); } }
    if (!decision) throw new Error("Visual review timed out; nothing accepted");
    if (decision.accept === true) {
      // Show the actual comparison control sweeping across the same pixels.
      const bounds = await slider.boundingBox();
      await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2); await page.mouse.down();
      for (let i = 0; i <= 60; i++) { await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * i / 60, bounds.y + bounds.height / 2); await pause(25); }
      for (let i = 60; i >= 0; i--) { await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * i / 60, bounds.y + bounds.height / 2); await pause(25); }
      await page.mouse.up(); await pause(1400);
      await click("Keep Version"); await expect(page.getByRole("link", { name: "Open in World" })).toBeVisible();
      kept = (await json(`/api/sketches/${draftId}`)).candidates.find(c => c.saved_node_id);
      event("artwork_kept"); break;
    }
    if (attempt === 2) throw new Error("Both candidates failed visual review; nothing accepted");
    await click("Refine drawing"); await prompt.fill(await prompt.inputValue() + `\n${decision.instruction || "Remove all annotation borders and match the original antique map."}`);
  }
  if (!kept) throw new Error("No kept artwork");
  await click("Map artwork", "link"); await click("Saved map artwork", "link");
  const versions = page.getByRole("combobox", { name: "Map artwork version" });
  await expect(versions).toHaveValue(kept.saved_node_id); event("updated_city_map"); await pause(2400);
  await click("Focus Mended Drum"); await pause(2300);
  await versions.selectOption({ label: "Original map" }); await pause(2000);
  await versions.selectOption(kept.saved_node_id); await pause(2500);
  await click("Show whole map"); await pause(1800);
  await page.reload(); await expect(versions).toHaveValue(kept.saved_node_id); await pause(2500);
  const final = await json(contextUrl);
  expect(final.scene.definition).toEqual(saved.scene.definition);
  expect(await json(`/api/world/${initial.session_id}/map`)).toEqual(savedMap);
  const image = await page.request.get(final.parent_source_url); await writeFile(`${output}/accepted-map.png`, await image.body());
  const hash = data => createHash("sha256").update(JSON.stringify(data)).digest("hex");
  checks = { geometry_unchanged_by_repaint: true, world_map_records_unchanged_by_repaint: true, accepted_artwork_after_reload: true, real_provider_result: !kept.mock, outside_changed: kept.outside_changed, geometry_sha256: hash(final.scene.definition), saved_revision: final.scene.revision };
  await page.screenshot({ path: `${output}/final.png` });
  if (full) exploration = await exploreWorld({ page, output, event, source, sessionId: saved.session_id });
  event("end");
  status = errors.length ? "failed" : "complete";
} catch (e) { errors.push((e.stack || String(e)).replace(/cookie:[^\n]*/gi, "cookie: [redacted]")); console.error(e.message); process.exitCode = 1; }
finally {
  await context.close(); await video.saveAs(`${output}/uncut.webm`); await browser.close();
  await writeFile(`${output}/receipt.json`, JSON.stringify({ status, errors, events, checks, exploration, generation_submissions: calls, source, draft_id: draftId, session_id: saved?.session_id, kept, edit: "None. One continuous browser recording. Full viewport; no cuts, speed changes, composited shots or synthetic camera motion. Generation, review, loading and persistence waits retained." }, null, 2));
}
console.log(output);
