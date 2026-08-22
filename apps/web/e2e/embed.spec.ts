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

  // 2) Gate open: the viewer renders the root with the child's entry dot.
  await page.goto(`/embed/${encodeURIComponent(sessionId)}`);
  await expect(page.getByTestId("embed-stage").locator("img")).toBeVisible({
    timeout: 30_000,
  });
  const dot = page.locator('button[title^="Enter "]');
  await expect(dot).toBeVisible({ timeout: 15_000 });

  // 3) Dot navigation: enter the child (ZERO generates on this surface),
  // then back returns to the root.
  let generates = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/generate-page") && req.method() === "POST") {
      generates += 1;
    }
  });
  await dot.click();
  await expect(page.getByRole("button", { name: "← back" })).toBeVisible();
  // The child is the frontier — no children of its own.
  await expect(page.getByText("world frontier")).toBeVisible({ timeout: 15_000 });

  // 4) Frontier tap → the continue hint, not silence (the /n/ dead-tap lesson).
  await page.getByTestId("embed-stage").click({ position: { x: 40, y: 40 } });
  await expect(page.getByText(/unexplored — continue this world/)).toBeVisible();
  expect(generates).toBe(0);

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
});
