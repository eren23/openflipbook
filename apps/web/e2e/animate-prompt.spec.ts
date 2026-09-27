import { expect, test } from "@playwright/test";

import { waitForStableImage } from "./helpers";

// Animate used to send the page title as the video prompt, with no way to
// say what should move. The prompt box beside the button now wins over the
// title, and an empty box keeps the title.
test("Animate sends the typed prompt, or the page title when the box is empty", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("a quiet harbour at dawn"));
  await waitForStableImage(page);

  const sent: string[] = [];
  // The clip itself is not the point: answer from here, so nothing is billed.
  await page.route("**/api/animate", async (route) => {
    sent.push((route.request().postDataJSON() as { prompt: string }).prompt);
    await route.fulfill({ json: { video_url: "about:blank", model: "test/animate", duration_seconds: 5 } });
  });

  const box = page.getByRole("textbox", { name: /what should move/i });
  const animate = page.getByRole("button", { name: /^Animate \(5s clip\)$/ });

  await box.fill("lanterns flicker on as dusk falls");
  await animate.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toBe("lanterns flicker on as dusk falls");

  // Typing again drops the old clip, so the button makes a new one rather
  // than replaying; clearing the box falls back to the page title.
  await page.getByRole("button", { name: /stop/i }).click().catch(() => {});
  await box.fill("");
  await page.getByRole("button", { name: /^Animate \(5s clip\)$/ }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).not.toBe("");
  expect(sent[1]).not.toBe("lanterns flicker on as dusk falls");
});
