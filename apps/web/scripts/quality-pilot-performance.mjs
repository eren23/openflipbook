import { cpus, platform, release, totalmem } from "node:os";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// This measures browser frame delivery while actually moving the camera.
// It is a diagnostic on named hardware, not an assertion of mobile-device speed.
export async function measureWorldPerformance(page, directory) {
  const results = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.getByRole("button", { name: "3D", exact: true }).click();
    const viewport = page.getByTestId("place-viewport").first();
    await viewport.scrollIntoViewIfNeeded();
    await viewport.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('[data-testid="place-viewport"]')?.getAttribute("data-ready") === "true");
    const canvas = viewport.locator("canvas"), box = await canvas.boundingBox();
    if (!box || box.height < 200 || box.width < 200) throw new Error("World canvas collapsed during performance measurement");
    const initialCamera = await viewport.getAttribute("data-camera");
    await page.evaluate(() => {
      const samples = []; let previous = performance.now();
      const run = now => {
        samples.push(now - previous); previous = now;
        if (samples.length < 300) requestAnimationFrame(run);
      };
      window.__qualityPilotFrames = samples; requestAnimationFrame(run);
    });
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .45);
    await page.mouse.down();
    try {
      for (let step = 1; step <= 90; step++) {
        await page.mouse.move(box.x + box.width * (.5 + .18 * step / 90), box.y + box.height * (.45 + .025 * step / 90));
        await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
      }
    } finally { await page.mouse.up(); }
    const finalCamera = await viewport.getAttribute("data-camera");
    if (initialCamera === finalCamera) throw new Error("Orbit input did not move the camera during measurement");
    const sample = await canvas.evaluate(element => {
      const intervals = window.__qualityPilotFrames.slice(5), sorted = [...intervals].sort((a, b) => a - b);
      if (intervals.length < 90) throw new Error("Insufficient moving-camera frame samples");
      const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const gl = element.getContext("webgl2") || element.getContext("webgl"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
      return { frames: intervals.length, median_ms: percentile(.5), p95_ms: percentile(.95), p99_ms: percentile(.99),
        mean_ms: intervals.reduce((a, b) => a + b, 0) / intervals.length, over_50_ms: intervals.filter(ms => ms > 50).length,
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "Not exposed", user_agent: navigator.userAgent,
        canvas: { width: element.width, height: element.height, css_width: element.clientWidth, css_height: element.clientHeight } };
    });
    results.push({ viewport: { width, height: width === 390 ? 844 : 900 }, initial_camera: initialCamera, final_camera: finalCamera, ...sample });
    await page.screenshot({ path: resolve(directory, `performance-${width}.png`) });
  }
  const report = { version: 1, measured_at: new Date().toISOString(), hardware: { cpu: cpus()[0]?.model, logical_cpus: cpus().length,
    platform: platform(), os_release: release(), memory_gib: Math.round(totalmem() / 2 ** 30) },
    method: "requestAnimationFrame intervals during actual 90-step orbit drag, first five frames omitted",
    limitation: "390px is a mobile viewport on this host, not a physical mobile device. Browser frame delivery is not GPU render duration.", results };
  await writeFile(resolve(directory, "performance.json"), JSON.stringify(report, null, 2));
  return report;
}
