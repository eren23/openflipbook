import { expect, test } from "@playwright/test";

import { clickAtImageFraction, waitForStableImage } from "./helpers";

// Fork this world: a viewer with a share link gets their OWN copy to extend
// (nodes + world model, ids reminted) — the safer sibling of ?continue=,
// which writes into the original. Hydrating a fork generates NOTHING, a tap
// grows only the fork, and the source session stays byte-count-identical.
test("fork copies the world; taps grow the fork, never the source", async ({
  page,
}) => {
  let sessionId = "";
  page.on("request", (req) => {
    if (req.url().includes("/api/generate-page") && req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      // Capture the SOURCE session once — the later tap inside the FORK also
      // fires a generate, and letting it overwrite this made sourceCount()
      // count the fork (the first CI run's red).
      if (body.session_id && !sessionId) sessionId = body.session_id;
    }
  });
  const persist = page.waitForResponse(
    (r) => r.url().includes("/api/nodes") && r.request().method() === "POST",
    { timeout: 90_000 },
  );
  await page.goto("/play?q=" + encodeURIComponent("a walled harbor town"));
  await waitForStableImage(page);
  const root = (await (await persist).json()) as { id?: string };
  expect(root.id).toBeTruthy();

  const sourceCount = async () => {
    const res = await page.request.get(
      `/api/sessions/${encodeURIComponent(sessionId)}?limit=200`,
    );
    const json = (await res.json()) as { nodes: unknown[] };
    return json.nodes.length;
  };
  const before = await sourceCount();
  expect(before).toBeGreaterThan(0);

  // Fork via the API (the /n/ page's button posts exactly this).
  const forkRes = await page.request.post(
    `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
    { data: { node_id: root.id } },
  );
  expect(forkRes.ok()).toBeTruthy();
  const fork = (await forkRes.json()) as { session_id: string; nodes: number };
  expect(fork.session_id).not.toBe(sessionId);
  expect(fork.nodes).toBe(before);

  // Hydrating the fork generates NOTHING…
  let generates = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/generate-page") && req.method() === "POST") {
      generates += 1;
    }
  });
  await page.goto(`/play?continue=${encodeURIComponent(fork.session_id)}`);
  await expect(
    page.locator('img[alt^="Generated illustration"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  expect(generates).toBe(0);

  // …and a tap grows the FORK, not the source.
  const forkPersist = page.waitForResponse(
    (r) => r.url().includes("/api/nodes") && r.request().method() === "POST",
    { timeout: 90_000 },
  );
  await clickAtImageFraction(page, 0.5, 0.5);
  await forkPersist;
  expect(await sourceCount()).toBe(before); // source untouched

  const forkNodes = await page.request.get(
    `/api/sessions/${encodeURIComponent(fork.session_id)}?limit=200`,
  );
  const forkJson = (await forkNodes.json()) as { nodes: unknown[] };
  expect(forkJson.nodes.length).toBe(before + 1);
});
