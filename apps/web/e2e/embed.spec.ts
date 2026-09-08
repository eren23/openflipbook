import { expect, test } from "@playwright/test";

import { clickAtImageFraction, waitForStableImage } from "./helpers";

// The embeddable world viewer: publish-gated, zero-generate, navigable
// through already-generated nodes only. One session exercises the whole
// contract — gate closed → publish → gate open → dot navigation → frontier
// hint → oEmbed provider.
test("embed viewer is publish-gated, navigates generated nodes, serves oEmbed", async ({
  page,
}) => {
  let sessionId = "";
  page.on("request", (req) => {
    if (req.url().includes("/api/generate-page") && req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.session_id) sessionId = body.session_id;
    }
  });
  const rootPersist = page.waitForResponse(
    (r) => r.url().includes("/api/nodes") && r.request().method() === "POST",
    { timeout: 90_000 },
  );
  await page.goto("/play?q=" + encodeURIComponent("an old stone tower"));
  await waitForStableImage(page);
  const root = (await (await rootPersist).json()) as { id?: string };
  expect(root.id).toBeTruthy();
  expect(sessionId).toBeTruthy();

  // One tap → one generated CHILD (the embed's navigation target).
  const childPersist = page.waitForResponse(
    (r) => r.url().includes("/api/nodes") && r.request().method() === "POST",
    { timeout: 90_000 },
  );
  await clickAtImageFraction(page, 0.5, 0.5);
  const child = (await (await childPersist).json()) as { id?: string };
  expect(child.id).toBeTruthy();

  // 1) Gate closed: an unpublished session must not be frameable — and the
  // oEmbed provider must not confirm it exists.
  const closed = await page.goto(`/embed/${encodeURIComponent(sessionId)}`);
  expect(closed!.status()).toBe(404);
  const oembedClosed = await page.request.get(
    `/api/oembed?url=${encodeURIComponent(`/n/${root.id}`)}`,
  );
  expect(oembedClosed.status()).toBe(404);

  // Publish (first-touch owner claim rides this browser context's cookie).
  const pub = await page.request.post("/api/gallery/publish", {
    data: { session_id: sessionId, node_id: root.id },
  });
  expect(pub.ok()).toBeTruthy();

  const rows = await page.request.get(`/api/nodes/${root.id}/children`);
  const savedChildren = (await rows.json()).children as {
    id: string; click_in_parent: { x_pct: number; y_pct: number };
  }[];
  // Use an off-centre API fixture: a centre pin cannot expose letterboxing bugs.
  const point = { x_pct: 0.27, y_pct: 0.31 };
  await page.route(`**/api/nodes/${root.id}/children`, (route) => route.fulfill({
    json: { children: savedChildren.map((c) => ({ ...c, click_in_parent: point })) },
  }));
  let generates = 0;
  page.on("request", (req) => {
    if (/\/api\/(generate-page|animate|ltx)(?:[/?-]|$)/.test(req.url())) generates += 1;
  });

  // 2) Gate open: the viewer renders the root with the child's entry dot.
  await page.goto(`/embed/${encodeURIComponent(sessionId)}`);
  await expect(page.getByTestId("embed-stage").locator("img")).toBeVisible({
    timeout: 30_000,
  });
  const dot = page.locator('button[title^="Enter "]');
  await expect(dot).toBeVisible({ timeout: 15_000 });
  const rootImage = await page.getByTestId("embed-stage").locator("img").getAttribute("src");

  // The marker centre must match IMAGE pixels, not the letterboxed stage.
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const image = await page.getByTestId("embed-stage").locator("img").evaluate((img: HTMLImageElement) => {
        const r = img.getBoundingClientRect();
        const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
        return { x: r.x + (r.width - img.naturalWidth * scale) / 2,
          y: r.y + (r.height - img.naturalHeight * scale) / 2,
          width: img.naturalWidth * scale, height: img.naturalHeight * scale };
      });
      const pin = (await dot.boundingBox())!;
      return Math.max(Math.abs(pin.x + pin.width / 2 - image.x - point.x_pct * image.width),
        Math.abs(pin.y + pin.height / 2 - image.y - point.y_pct * image.height));
    }).toBeLessThan(2);
    await dot.focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    const label = (await page.getByRole("tooltip").boundingBox())!;
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.x + label.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/embed-mobile.png" });

  // 3) Dot navigation: enter the child (ZERO generates on this surface),
  // then back returns to the root.
  await dot.click();
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  // The child is the frontier — no children of its own.
  await expect(page.getByText("world frontier")).toBeVisible({ timeout: 15_000 });

  // 4) Frontier tap → the continue hint, not silence (the /n/ dead-tap lesson).
  await page.getByTestId("embed-stage").locator("img").click();
  await expect(page.getByText(/unexplored — continue this world/)).toBeVisible();
  expect(generates).toBe(0);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("embed-stage").getByRole("img")).toHaveAttribute("src", rootImage!);
  await expect(page.getByTestId("spatial-transition")).toHaveCount(0);
  await expect(dot).toBeVisible();

  // 5) oEmbed provider: a /n/ permalink resolves to the published session's
  // interactive iframe.
  const oembed = await page.request.get(
    `/api/oembed?url=${encodeURIComponent(`/n/${root.id}`)}`,
  );
  expect(oembed.ok()).toBeTruthy();
  const payload = (await oembed.json()) as {
    type?: string;
    html?: string;
    thumbnail_url?: string;
  };
  expect(payload.type).toBe("rich");
  expect(payload.html).toContain(`/embed/${sessionId}`);
  expect(payload.html).toContain("iframe");

  // 6) Tour mode: the world plays itself inside the embed — the overlay
  // opens on the root page and Escape closes it (zero generates, again).
  await page.getByRole("button", { name: "▶ tour" }).click();
  const tour = page.getByTestId("tour-player");
  await expect(tour).toBeVisible({ timeout: 15_000 });
  await expect(tour.locator("img").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tour).not.toBeVisible();
  expect(generates).toBe(0);

  // 7) The gallery shelf: the published world's card carries its stats and
  // its own tour + fork actions.
  await page.goto("/gallery");
  const card = page.locator("li", { hasText: "2 pages" }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole("button", { name: "▶ tour" })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Fork this world" }),
  ).toBeVisible();
});
