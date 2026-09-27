import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dir = resolve("../../docs/research/assets/sketch-trials/native-demo-v2");
const receipt = JSON.parse(
  await readFile(resolve(dir, "receipt.json"), "utf8"),
);
await mkdir(resolve(dir, "replay"), { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  storageState: "test-results/sketch-demo-owner-state.private.json",
  recordVideo: {
    dir: resolve(dir, "replay"),
    size: { width: 1440, height: 1000 },
  },
});
const page = await context.newPage();
let attempts = 0;
await page.route("**/api/generate-page", (route) => {
  attempts++;
  return route.abort();
});
try {
  await page.goto(receipt.url);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page
    .getByAltText("Generated candidate")
    .evaluate((image) => image.decode());
  await page.getByRole("link", { name: "Open in World" }).waitFor();
  const slider = page.getByRole("slider", {
    name: "Before and after comparison",
  });
  await slider.fill("100");
  await page.screenshot({ path: resolve(dir, "replay/before.png") });
  // Presentation holds only; all state and images came from the saved UI.
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 100; i >= 0; i -= 5) {
    await slider.fill(String(i));
    await new Promise((r) => setTimeout(r, 60));
  }
  await page.screenshot({ path: resolve(dir, "replay/after.png") });
  await new Promise((r) => setTimeout(r, 2500));
  const response = await context.request.get(receipt.candidate.image_url);
  if (!response.ok()) throw new Error("Candidate image could not be fetched");
  await writeFile(resolve(dir, "candidate.png"), await response.body());
  await writeFile(
    resolve(dir, "replay/receipt.json"),
    JSON.stringify(
      {
        generation_requests: attempts,
        reloaded: true,
        kept: true,
        candidate_id: receipt.candidate.id,
      },
      null,
      2,
    ),
  );
  if (attempts) throw new Error("Replay attempted generation");
  console.log(
    "Saved preview decoded; kept version reopened; zero generation requests.",
  );
} finally {
  await context.close();
  await browser.close();
}
