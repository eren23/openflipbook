import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_CONNECTED_DEMO !== "1", "Isolated local saved-world demo; no generation");
test.use({ video: "on" });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`connected route preserves exact saved views at ${viewport.width}px`, async ({ page, request }) => {
    const manifest = JSON.parse(await readFile("../modal-backend/tests/continuity_bench/reports/connected-demo/local-world.json", "utf8"));
    const requests: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => {
      if (req.method() !== "GET" || /\/api\/(generate|animate|ltx)/.test(req.url())) requests.push(req.url());
    });
    await page.setViewportSize(viewport);
    const path = new URL(manifest.url).pathname;
    await page.goto(path);
    const stage = page.getByTestId("embed-stage");
    const visited: { name: string; image: string }[] = [];
    for (const [index, name] of manifest.route.entries()) {
      const node = manifest.nodes[name];
      if (index > 0) {
        const previous = manifest.route[index - 1];
        if (manifest.nodes[previous].parent === name) await page.getByRole("button", { name: "Back", exact: true }).click();
        else await page.getByRole("button", { name: `Enter ${node.title}`, exact: true }).click();
      }
      const image = stage.getByRole("img", { name: node.title, exact: true });
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true);
      const src = (await image.getAttribute("src"))!;
      expect(src.endsWith(node.image_key)).toBe(true);
      const returned = visited.find(v => v.name === name);
      if (returned) expect(src).toBe(returned.image);
      const response = await request.get(src);
      expect(response.ok()).toBe(true);
      expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(node.sha256);
      visited.push({ name, image: src });
      if (name === "root") await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
      else await expect(page.getByRole("button", { name: "Back", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/connected-${viewport.width}-${index}-${name}.png` });
    }
    await page.reload();
    await expect(stage.getByRole("img", { name: manifest.nodes.root.title, exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Enter ${manifest.nodes.market.title}`, exact: true }).click();
    await expect(stage.getByRole("img", { name: manifest.nodes.market.title, exact: true })).toHaveAttribute("src", visited[1]!.image);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
