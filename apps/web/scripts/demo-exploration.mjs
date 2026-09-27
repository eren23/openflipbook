import { writeFile, readFile } from "node:fs/promises";
import { expect } from "@playwright/test";

export async function exploreWorld({ page, output, event, sessionId }) {
  const pause = ms => page.waitForTimeout(ms);
  const img = () => page.locator('img[alt^="Generated illustration"]').first();
  const currentNode = async () => {
    const code = page.locator("code").filter({ hasText: /^\/n\// }).first();
    return (await code.textContent()).trim().replace(/^\/n\//, "");
  };
  const stable = async () => {
    await expect(img()).toBeVisible({ timeout: 780000 });
    await expect(page.getByRole("button", { name: "Around", exact: true })).toBeEnabled({ timeout: 780000 });
    await expect.poll(() => img().evaluate(i => i.naturalWidth), { timeout: 60000 }).toBeGreaterThan(0);
    await expect.poll(() => img().evaluate(i => i.complete), { timeout: 120000 }).toBe(true);
    await pause(2000);
  };
  const review = async name => {
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    const node = await currentNode();
    await writeFile(`${output}/pending-${name}.json`, JSON.stringify({ node, url: page.url(), image: await img().getAttribute("src") }, null, 2));
    event(`review_${name}`);
    for (let i = 0; i < 240; i++) {
      try { const d = JSON.parse(await readFile(`${output}/decision-${name}.json`, "utf8")); if (!d.accept) throw new Error(`Visual review rejected ${name}`); return { node, ...d }; }
      catch (e) { if (e.code !== "ENOENT") throw e; await pause(1000); }
    }
    throw new Error(`Visual review timed out: ${name}`);
  };
  await page.getByRole("button", { name: "Street", exact: true }).click(); await pause(1200);
  await page.getByRole("link", { name: "Explore world", exact: true }).click(); await stable();
  const labels = page.getByRole("button", { name: "labels", exact: true });
  if (await labels.getAttribute("aria-pressed") === "true") await labels.click();
  const codex = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
  if (await codex.isVisible()) await codex.getByRole("button", { name: "Close", exact: true }).click();
  await pause(1400); event("explorer_street");
  const streetNode = await currentNode();
  const requests = [];
  const expansionIds = new Set();
  const onResponse = async response => {
    if (response.url().endsWith("/api/nodes") && response.request().method() === "POST" && response.request().postDataJSON()?.relation === "expand" && response.ok()) {
      const saved = await response.json().catch(() => null);
      if (saved?.id) expansionIds.add(saved.id);
    }
  };
  page.on("response", onResponse);
  const onRequest = request => { if (request.url().endsWith("/api/generate-page")) { const b = request.postDataJSON(); requests.push({ mode: b.mode, parent: b.current_node_id, hint: b.click_hint, max_attempts: b.max_attempts }); } };
  page.on("request", onRequest);
  async function enter(x, y, note, name) {
    const before = await currentNode();
    const point = await img().evaluate((i, p) => {
      const b = i.getBoundingClientRect(), scale = Math.min(b.width / i.naturalWidth, b.height / i.naturalHeight);
      return { x: b.x + (b.width - i.naturalWidth * scale) / 2 + i.naturalWidth * scale * p.x, y: b.y + (b.height - i.naturalHeight * scale) / 2 + i.naturalHeight * scale * p.y };
    }, { x, y });
    await page.mouse.move(point.x, point.y, { steps: 15 });
    await page.keyboard.down("Meta"); await page.mouse.click(point.x, point.y); await page.keyboard.up("Meta");
    const hint = page.getByRole("textbox", { name: "Click hint" });
    if (await hint.isVisible()) { await hint.fill(note); await pause(1500); await page.getByRole("button", { name: "Submit hint" }).click(); }
    else { await page.getByTestId("detail-note").fill(note); await pause(1500); await page.getByTestId("detail-confirm").click(); }
    event(`${name}_generation`);
    const deadline = Date.now() + 780000;
    while (await currentNode() === before) {
      if (await page.getByRole("button", { name: "Dismiss generation error", exact: true }).isVisible()) throw new Error("Generation failed; inspect the recorded error before retrying");
      if (Date.now() >= deadline) throw new Error(`Entry timed out: ${name}`);
      await pause(1000);
    }
    await stable(); return review(name);
  }
  const interior = await enter(.57, .59, "Enter through this doorway into the Mended Drum tavern. Eye-level INSIDE the same timber-and-stone building: bar, stools, rafters and fireplace. Interior only, not another facade, map or cutaway. Preserve the source's illustrated style.", "tavern-interior");
  await page.getByRole("button", { name: "← back", exact: true }).click(); await stable(); expect(await currentNode()).toBe(streetNode);
  event("return_to_street");
  const beforeReplay = requests.length;
  await page.getByRole("button", { name: "forward →", exact: true }).click(); await stable(); expect(await currentNode()).toBe(interior.node);
  expect(requests).toHaveLength(beforeReplay); event("interior_revisit_no_generation");
  await page.getByRole("button", { name: "← back", exact: true }).click(); await stable();
  event("expand_around_start"); await page.getByRole("button", { name: "Around", exact: true }).click();
  const tiles = page.getByRole("button", { name: /^Explore / });
  await expect.poll(() => tiles.count(), { timeout: 780000 }).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Around", exact: true })).toBeEnabled({ timeout: 780000 });
  await page.screenshot({ path: `${output}/expanded-areas.png`, fullPage: true });
  const options = await tiles.allTextContents();
  await expect.poll(() => expansionIds.size, { timeout: 60000 }).toBe(options.length);
  await writeFile(`${output}/pending-area.json`, JSON.stringify({ options }, null, 2)); event("review_expanded_areas");
  let choice;
  for (let i = 0; i < 240; i++) { try { choice = JSON.parse(await readFile(`${output}/decision-area.json`, "utf8")); break; } catch (e) { if (e.code !== "ENOENT") throw e; await pause(1000); } }
  if (!choice || !Number.isInteger(choice.index) || choice.index < 0 || choice.index >= options.length) throw new Error("No reviewed expanded area selected");
  await tiles.nth(choice.index).click(); await stable();
  const area = await review("expanded-area");
  let second = null;
  if (area.enter) second = await enter(area.enter.x, area.enter.y, area.enter.note, "second-interior");
  if (second) { await page.getByRole("button", { name: "← back", exact: true }).click(); await stable(); expect(await currentNode()).toBe(area.node); }
  const download = await page.request.get(`/api/export/session/${sessionId}`, { timeout: 180000 });
  if (!download.ok()) throw new Error(`World export failed: ${download.status()}`);
  await writeFile(`${output}/world.zip`, await download.body());
  // The UI opens a new tab; navigate to its actual href in the recorded tab.
  const atlasUrl = await page.getByRole("link", { name: "↗ atlas", exact: true }).getAttribute("href");
  await page.goto(atlasUrl); await pause(2500);
  await page.screenshot({ path: `${output}/atlas.png`, fullPage: true }); event("atlas_and_export");
  page.off("request", onRequest);
  page.off("response", onResponse);
  return { street_node: streetNode, interior_node: interior.node, expanded_area_node: area.node, second_interior_node: second?.node, expanded_options: options, distinct_expansion_nodes: [...expansionIds], revisit_generations: 0, export: "world.zip", requests };
}
