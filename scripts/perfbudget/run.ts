/**
 * Perf-budget runner: drives /play through the same flow as the demo
 * recorder, but instead of capturing video, it asserts a handful of
 * latency budgets and dumps a report.
 *
 * Usage (from repo root):
 *   docker compose up -d --build              # stack on localhost:3000
 *   pnpm tsx scripts/perfbudget/run.ts        # one-shot run
 *
 * Tunables (env):
 *   PERF_BASE_URL                 default http://localhost:3000
 *   PERF_BUDGET_TTFP_MS           default 1500
 *   PERF_BUDGET_FIRST_STATUS_MS   default 4000  (LAN to local backend; cold-cache)
 *   PERF_BUDGET_FINAL_P95_MS      default 25000 (depends on fal/openrouter latency)
 *   PERF_BUDGET_CLS               default 0.1
 *
 * Exits non-zero on any breach. Writes scripts/perfbudget/report.json.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, "report.json");

const BASE_URL = process.env.PERF_BASE_URL ?? "http://localhost:3000";
const TTFP = Number(process.env.PERF_BUDGET_TTFP_MS ?? "1500");
const FIRST_STATUS = Number(process.env.PERF_BUDGET_FIRST_STATUS_MS ?? "4000");
const FINAL_P95 = Number(process.env.PERF_BUDGET_FINAL_P95_MS ?? "25000");
const CLS_BUDGET = Number(process.env.PERF_BUDGET_CLS ?? "0.1");

interface Sample {
  ttfp_ms: number;
  first_status_ms: number;
  final_ms: number;
  cls: number;
}

async function measureOnce(): Promise<Sample> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Subscribe to the HUD pubsub so we can stamp first-status / final times.
  await page.addInitScript(() => {
    (window as unknown as { __pb: Record<string, number> }).__pb = {
      sse_first_status_at: 0,
      sse_final_at: 0,
      cls: 0,
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEntry[]) {
        const ev = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
        if (ev.hadRecentInput) continue;
        const v = ev.value ?? 0;
        const w = window as unknown as { __pb: Record<string, number> };
        w.__pb.cls = (w.__pb.cls ?? 0) + v;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  const ttfpStart = Date.now();
  await page.goto(
    `${BASE_URL}/play?q=${encodeURIComponent("how does a steam engine work")}&debug=1`,
    { waitUntil: "domcontentloaded" }
  );
  const ttfp_ms = Date.now() - ttfpStart;

  // Wait for the first status SSE event by polling the HUD's timeline element
  // (fall back to plain timing if HUD isn't mounted).
  const submitAt = Date.now();
  // Page generation begins on mount because of ?q=.
  let firstStatus = 0;
  const firstDeadline = submitAt + 30_000;
  while (Date.now() < firstDeadline) {
    const banner = await page.locator(".rounded-full:has-text('…')").first();
    if (await banner.isVisible().catch(() => false)) {
      firstStatus = Date.now() - submitAt;
      break;
    }
    await page.waitForTimeout(150);
  }

  const finalStart = Date.now();
  const img = page.locator('img[alt^="Generated illustration"]');
  await img.waitFor({ state: "visible", timeout: 90_000 });
  let lastSrc = "";
  let stableSince = 0;
  const finalDeadline = Date.now() + 90_000;
  while (Date.now() < finalDeadline) {
    const src = (await img.getAttribute("src")) ?? "";
    if (src && src === lastSrc) {
      if (Date.now() - stableSince >= 1500) break;
    } else {
      lastSrc = src;
      stableSince = Date.now();
    }
    await page.waitForTimeout(500);
  }
  const final_ms = Date.now() - finalStart;

  const cls = (await page.evaluate(
    () => (window as unknown as { __pb: { cls?: number } }).__pb?.cls ?? 0
  )) as number;

  await browser.close();
  return { ttfp_ms, first_status_ms: firstStatus, final_ms, cls };
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

async function main(): Promise<void> {
  const samples: Sample[] = [];
  for (let i = 0; i < 3; i++) samples.push(await measureOnce());

  const report = {
    base_url: BASE_URL,
    ttfp_ms_max: Math.max(...samples.map((s) => s.ttfp_ms)),
    first_status_ms_max: Math.max(...samples.map((s) => s.first_status_ms)),
    final_p95_ms: p95(samples.map((s) => s.final_ms)),
    cls_max: Math.max(...samples.map((s) => s.cls)),
    samples,
    budgets: { TTFP, FIRST_STATUS, FINAL_P95, CLS_BUDGET },
  };

  await writeFile(REPORT, JSON.stringify(report, null, 2));

  const breaches: string[] = [];
  if (report.ttfp_ms_max > TTFP) breaches.push(`TTFP > ${TTFP}`);
  if (report.first_status_ms_max > FIRST_STATUS)
    breaches.push(`first_status > ${FIRST_STATUS}`);
  if (report.final_p95_ms > FINAL_P95) breaches.push(`final_p95 > ${FINAL_P95}`);
  if (report.cls_max > CLS_BUDGET) breaches.push(`CLS > ${CLS_BUDGET}`);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
  if (breaches.length) {
    // eslint-disable-next-line no-console
    console.error(`PERF BUDGET BREACH: ${breaches.join(", ")}`);
    process.exit(1);
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(2);
});
