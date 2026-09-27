import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { blankSketch } from "../lib/sketch-types";

test.skip(
  process.env.E2E_SKETCH !== "1",
  "Explicit local Sketch tests with MOCK_PROVIDERS=1",
);
test.beforeEach(async ({ baseURL }) => {
  if (
    !baseURL ||
    new URL(baseURL).hostname !== "127.0.0.1" ||
    process.env.E2E_MOCK !== "1"
  )
    throw new Error("Sketch tests require localhost and E2E_MOCK=1");
});

test("draw, export, save, generate, keep and reopen without regeneration", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/sketch");
  await expect(
    page.getByRole("radio", { name: "Rectangle", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Sketch title" })
    .fill("Coastal village browser proof");
  await page
    .getByRole("textbox", { name: "Your idea" })
    .fill("A lighthouse left of a blue harbor");
  await page
    .locator("label")
    .filter({
      has: page.getByRole("radio", { name: "Rectangle", exact: true }),
    })
    .click();
  const box = await page.getByTestId("sketch-canvas").boundingBox();
  if (!box) throw new Error("Canvas missing");
  await page.mouse.move(box.x + box.width * 0.44, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.65, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save drawing", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const url = page.url();
  const id = new URL(url).searchParams.get("id")!;
  let document = await (
    await context.request.get(`/api/sketches/${id}`)
  ).json();
  expect(document.sketch.state.scene.elements.length).toBeGreaterThan(0);
  expect(
    document.sketch.state.scene.elements.every(
      (e: { id: string }) => !e.id.startsWith("ofb-"),
    ),
  ).toBe(true);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Bundle", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain(".ofb-sketch");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Keep Version", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: "test-results/sketch-desktop-compare.png" });
  await page.getByRole("button", { name: "Keep Version", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open in World" })).toBeVisible();
  document = await (await context.request.get(`/api/sketches/${id}`)).json();
  expect(document.candidates[0].saved_node_id).toBeTruthy();
  const retry = await context.request.post(`/api/sketches/${id}/accept`, {
    data: {
      candidate_id: document.candidates[0].id,
      revision: document.sketch.revision,
    },
  });
  expect((await retry.json()).node_id).toBe(
    document.candidates[0].saved_node_id,
  );
  expect(
    (
      await context.request.post(`/api/sketches/${id}/discard`, {
        data: { candidate_id: document.candidates[0].id },
      })
    ).status(),
  ).toBe(409);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Sketch title" })).toHaveValue(
    "Coastal village browser proof",
  );
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open in World" })).toBeVisible();
  expect(
    (await (await context.request.get(`/api/sketches/${id}`)).json())
      .candidates,
  ).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("protected correction rejects an empty region, then exports aligned source and mask", async ({
  page,
  context,
}) => {
  const bytes = await readFile(
    "../modal-backend/tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg",
  );
  await page.goto("/sketch");
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "Harbor.jpg",
    mimeType: "image/jpeg",
    buffer: bytes,
  });
  await expect(
    page.getByRole("heading", { name: "Draw a correction" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Rectangle", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Your changes" })
    .fill("Red roof on the waterfront building");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Select an editable region" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Rectangle region", exact: true })
    .click();
  const box = await page.getByTestId("sketch-canvas").boundingBox();
  if (!box) throw new Error("Canvas missing");
  await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.6, {
    steps: 10,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByText("Outside region unchanged", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Keep Version" }),
  ).toBeEnabled();
  const id = new URL(page.url()).searchParams.get("id")!;
  const before = await (
    await context.request.get(`/api/sketches/${id}`)
  ).json();
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Your changes" })
    .fill("An entirely different instruction");
  await page.getByRole("button", { name: "Save drawing", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  const changed = await (
    await context.request.get(`/api/sketches/${id}`)
  ).json();
  const stale = await context.request.post(`/api/sketches/${id}/accept`, {
    data: {
      candidate_id: before.candidates[0].id,
      revision: changed.sketch.revision,
    },
  });
  expect(stale.status()).toBe(409);
  await context.request.post(`/api/sketches/${id}/restore`, {
    data: {
      candidate_id: before.candidates[0].id,
      revision: changed.sketch.revision,
    },
  });
  const restored = await (
    await context.request.get(`/api/sketches/${id}`)
  ).json();
  expect(restored.sketch.revision).toBeGreaterThan(changed.sketch.revision);
  expect(restored.candidates[0].matches_draft).toBe(true);
  const discarded = await context.request.post(`/api/sketches/${id}/discard`, {
    data: { candidate_id: before.candidates[0].id },
  });
  expect(discarded.ok()).toBe(true);
  expect(
    (await (await context.request.get(`/api/sketches/${id}`)).json())
      .candidates,
  ).toEqual([]);
  expect(
    (
      await context.request.post(`/api/sketches/${id}/accept`, {
        data: {
          candidate_id: before.candidates[0].id,
          revision: restored.sketch.revision,
        },
      })
    ).status(),
  ).toBe(404);
});

test("ownership, concurrency, and malformed scenes fail before paid work", async ({
  context,
  playwright,
  baseURL,
}) => {
  const created = await context.request.post("/api/sketches", {
    data: { state: blankSketch() },
  });
  expect(created.ok()).toBe(true);
  const { sketch } = await created.json();
  const stranger = await playwright.request.newContext({ baseURL: baseURL! });
  expect((await stranger.get(`/api/sketches/${sketch.id}`)).status()).toBe(403);
  expect(
    (
      await stranger.put(`/api/sketches/${sketch.id}`, {
        data: { state: blankSketch(), revision: 1 },
      })
    ).status(),
  ).toBe(403);
  const changed = { ...blankSketch(), title: "First tab" };
  expect(
    (
      await context.request.put(`/api/sketches/${sketch.id}`, {
        data: { state: changed, revision: 1 },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await context.request.put(`/api/sketches/${sketch.id}`, {
        data: { state: blankSketch(), revision: 1 },
      })
    ).status(),
  ).toBe(409);
  await stranger.dispose();
});

test("mobile canvas, settings and freehand drawing remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sketch");
  await expect(
    page.getByRole("radio", { name: "Draw", exact: true }),
  ).toBeVisible();
  await page
    .locator("label")
    .filter({ has: page.getByRole("radio", { name: "Draw", exact: true }) })
    .click();
  const box = await page.getByTestId("sketch-canvas").boundingBox();
  if (!box) throw new Error("Canvas missing");
  await page.mouse.move(box.x + 180, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 260, { steps: 20 });
  await page.mouse.up();
  await page
    .getByRole("button", { name: "Generation settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Generate", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Your idea" })
    .fill("A little seaside house");
  await page
    .getByLabel("Finish as", { exact: true })
    .selectOption("environment");
  await page.getByLabel("Workflow", { exact: true }).selectOption("material");
  await page.getByLabel("Material", { exact: true }).selectOption("ceramic");
  await page.getByRole("button", { name: "Save drawing", exact: true }).click();
  await expect(page.getByRole("status", { includeHidden: true })).toHaveText(
    "Saved",
  );
  await page.screenshot({ path: "test-results/sketch-mobile-settings.png" });
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.screenshot({ path: "test-results/sketch-mobile-canvas.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("alternate view requires whole-image consent and remains an unverified proposal after keep and reload", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const buffer = await readFile(
    "../modal-backend/tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg",
  );
  await page.goto("/sketch");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "Harbor.jpg", mimeType: "image/jpeg", buffer });
  await expect(
    page.getByRole("heading", { name: "Draw a correction" }),
  ).toBeVisible();
  await page.getByLabel("Workflow", { exact: true }).selectOption("viewpoint");
  await page
    .getByLabel("Proposed view", { exact: true })
    .selectOption("eye_level");
  await page
    .getByLabel("Your changes", { exact: true })
    .fill("Same harbor, lighthouse stays beside the quay");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "whole-image scope" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Whole image", exact: true }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByText("Proposed view · Geometry unverified"),
  ).toBeVisible();
  await expect(
    page.getByText("Outside region unchanged", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Keep Version", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open in World" })).toBeVisible();
  const id = new URL(page.url()).searchParams.get("id")!;
  const result = await (
    await context.request.get(`/api/sketches/${id}`)
  ).json();
  expect(result.candidates[0]).toMatchObject({
    workflow: "viewpoint",
    mock: true,
  });
  await page.reload();
  await expect(page.getByLabel("Workflow", { exact: true })).toHaveValue(
    "viewpoint",
  );
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(
    page.getByText("Proposed view · Geometry unverified"),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/sketch-viewpoint-desktop.png" });
  expect(errors).toEqual([]);
});

test("object placement requires a reference and region and keeps source pixels protected", async ({
  page,
  context,
}) => {
  const buffer = await readFile(
    "../modal-backend/tests/click_bench/fixtures/images/real/harbor_aethelgard.jpg",
  );
  await page.goto("/sketch");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "Harbor.jpg", mimeType: "image/jpeg", buffer });
  await expect(
    page.getByRole("heading", { name: "Draw a correction" }),
  ).toBeVisible();
  await page.getByLabel("Workflow", { exact: true }).selectOption("placement");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "object reference" }),
  ).toBeVisible();
  await page
    .getByLabel("Object reference file", { exact: true })
    .setInputFiles({ name: "Reference.jpg", mimeType: "image/jpeg", buffer });
  await expect(
    page.getByAltText("Object reference", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Select an editable region" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Rectangle region", exact: true })
    .click();
  const box = await page.getByTestId("sketch-canvas").boundingBox();
  if (!box) throw new Error("Canvas missing");
  await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.6, {
    steps: 10,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    page.getByText("Outside region unchanged", { exact: true }),
  ).toBeVisible();
  const id = new URL(page.url()).searchParams.get("id")!;
  const result = await (
    await context.request.get(`/api/sketches/${id}`)
  ).json();
  expect(result.candidates[0]).toMatchObject({
    workflow: "placement",
    mock: true,
    outside_changed: 0,
  });
  expect(result.sketch.state.subject_data_url).toBeTruthy();
  expect(result.sketch.state.style_data_url).toBeUndefined();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Generation settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Generate Another", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/sketch-placement-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
