import { expect, test } from "@playwright/test";

import { clickAtImageFraction, waitForStableImage } from "./helpers";

// Tap = ENTER, and buildings go INSIDE (#167 + #161/#166). The mock classifier
// steers on the query's trigger words: "tower" → enter_as scene + place_form
// interior, so the tap rides the REAL interior-enter path (instruction, judge
// swap, scene_view stamp) with only the model replies canned. The SSE stream
// is the wire contract those PRs shipped — asserting it beats any DOM hook.
test("world tap on a tower ENTERS and arrives INDOORS (one hop)", async ({ page }) => {
  await page.goto("/play?q=" + encodeURIComponent("an old stone tower"));
  await waitForStableImage(page);

  const respPromise = page.waitForResponse(
    (r) =>
      r.url().includes("/api/generate-page") &&
      r.request().method() === "POST" &&
      (r.request().postData() ?? "").includes('"mode":"tap"'),
    { timeout: 60_000 },
  );

  await clickAtImageFraction(page, 0.5, 0.5);

  const resp = await respPromise;
  expect(resp.status()).toBe(200);
  // text() resolves when the SSE stream closes; _sse emits with ": " separators.
  const stream = await resp.text();
  expect(stream).toContain('"image_op": "enter_scene"');
  expect(stream).toContain('"place_form": "interior"');
  expect(stream).toContain('"scale_tier": "room"');
});
