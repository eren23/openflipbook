/**
 * UX understandability bench — Playwright + VLM agent loop.
 *
 * Usage (from repo root, stack on localhost:3000):
 *   pnpm tsx scripts/ux-bench/run.ts              # dry-run task list
 *   UX_BENCH_RUN=1 pnpm tsx scripts/ux-bench/run.ts  # live agent loop
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(HERE, "tasks");
const REPORTS_DIR = path.join(HERE, "reports");
const BASE_URL = process.env.UX_BENCH_BASE_URL ?? "http://localhost:3000";

// Best-effort .env load so OPENROUTER_API_KEY resolves without a manual export
// (the key lives in apps/modal-backend/.env; mirrors the Python bench's loader).
async function loadEnv(): Promise<void> {
  const envPath = path.join(HERE, "..", "..", "apps", "modal-backend", ".env");
  try {
    const text = await readFile(envPath, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* no .env — rely on the ambient environment */
  }
}

const LIVE = process.env.UX_BENCH_RUN === "1";

interface Task {
  id: string;
  blind: boolean;
  start_url: string;
  goal: string;
  success_criteria: string[];
  max_steps: number;
  timeout_ms: number;
}

interface AgentAction {
  action: "click" | "type" | "wait" | "done";
  x_pct?: number;
  y_pct?: number;
  text?: string;
  rationale?: string;
}

interface StepTrace {
  step: number;
  action: AgentAction;
  dwell_ms: number;
  url: string;
  screenshot: string;
}

interface Friction {
  slowest_step: number;
  slowest_ms: number;
  revisits: number; // returned to a URL seen earlier — backtracking
  stuck_runs: number; // consecutive identical actions on an unchanged URL
  median_step_ms: number;
}

interface GoalVerdict {
  achieved: boolean;
  why: string;
}

async function loadTasks(): Promise<Task[]> {
  const files = await readdir(TASKS_DIR);
  const tasks: Task[] = [];
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    tasks.push(JSON.parse(await readFile(path.join(TASKS_DIR, f), "utf8")) as Task);
  }
  return tasks;
}

async function callVlm(screenshotB64: string, goal: string, step: number): Promise<AgentAction> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { action: "done", rationale: "no OPENROUTER_API_KEY — dry mock" };
  }
  const model = process.env.OPENROUTER_VLM_MODEL ?? "google/gemini-3-flash-preview";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are a blind UX tester. Goal: ${goal}\nStep ${step}. Reply JSON only: {"action":"click"|"type"|"wait"|"done","x_pct":0-100,"y_pct":0-100,"text":"...","rationale":"..."}`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${screenshotB64}` },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    return { action: "wait", rationale: `vlm error ${res.status}` };
  }
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const raw = data.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw) as AgentAction;
}

// Where did the blind agent struggle? Pure analysis over the trace: which step
// ate the most wall-time, how often it backtracked to a URL it had already
// seen, and runs where it repeated the exact same action on an unchanged page
// (the classic "I'm stuck and poking the same spot" signal).
function computeFriction(trace: StepTrace[]): Friction {
  let slowest_step = 0;
  let slowest_ms = -1;
  for (const t of trace) {
    if (t.dwell_ms > slowest_ms) {
      slowest_ms = t.dwell_ms;
      slowest_step = t.step;
    }
  }
  const seen: string[] = [];
  let revisits = 0;
  for (const t of trace) {
    if (seen.includes(t.url)) revisits++;
    seen.push(t.url);
  }
  let stuck_runs = 0;
  for (let i = 1; i < trace.length; i++) {
    const cur = trace[i];
    const prev = trace[i - 1];
    if (!cur || !prev) continue;
    const same =
      cur.action.action === prev.action.action &&
      cur.action.x_pct === prev.action.x_pct &&
      cur.action.y_pct === prev.action.y_pct &&
      cur.action.text === prev.action.text;
    if (same && cur.url === prev.url) stuck_runs++;
  }
  const sorted = trace.map((t) => t.dwell_ms).sort((a, b) => a - b);
  const median_step_ms = sorted.length
    ? (sorted[Math.floor(sorted.length / 2)] ?? 0)
    : 0;
  return {
    slowest_step,
    slowest_ms: Math.max(0, slowest_ms),
    revisits,
    stuck_runs,
    median_step_ms,
  };
}

// Stronger than URL/step-count proxies: ask the VLM to look at the FINAL screen
// and judge whether the goal actually happened. A blind agent can rack up steps
// without ever reaching the goal — this catches that.
async function verifyGoal(screenshotB64: string, goal: string): Promise<GoalVerdict> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { achieved: false, why: "no OPENROUTER_API_KEY" };
  const model = process.env.OPENROUTER_VLM_MODEL ?? "google/gemini-3-flash-preview";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are a strict UX auditor. The tester's goal was: ${goal}\nLooking ONLY at this final screenshot, was the goal achieved? Reply JSON only: {"achieved":true|false,"why":"<one short sentence>"}`,
            },
            { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotB64}` } },
          ],
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) return { achieved: false, why: `vlm error ${res.status}` };
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  try {
    const p = JSON.parse(data.choices[0]?.message?.content ?? "{}") as GoalVerdict;
    return { achieved: Boolean(p.achieved), why: String(p.why ?? "") };
  } catch {
    return { achieved: false, why: "unparseable verdict" };
  }
}

function evaluateSuccess(task: Task, finalUrl: string, trace: StepTrace[]): boolean {
  for (const criterion of task.success_criteria) {
    if (criterion.includes("url contains") && criterion.includes("/n/")) {
      if (!finalUrl.includes("/n/")) return false;
    }
    if (criterion === "page has generated image" && trace.length < 2) return false;
  }
  return trace.length > 0;
}

async function runTask(task: Task, runDir: string): Promise<Record<string, unknown>> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const trace: StepTrace[] = [];
  const t0 = Date.now();

  await page.goto(`${BASE_URL}${task.start_url}`, { waitUntil: "domcontentloaded" });

  for (let step = 1; step <= task.max_steps; step++) {
    if (Date.now() - t0 > task.timeout_ms) break;

    const shotPath = path.join(runDir, `step-${step}.png`);
    await page.screenshot({ path: shotPath });
    const buf = await readFile(shotPath);
    const b64 = buf.toString("base64");

    const stepStart = Date.now();
    const action = LIVE
      ? await callVlm(b64, task.goal, step)
      : { action: "done" as const, rationale: "dry-run" };

    if (action.action === "click" && action.x_pct != null && action.y_pct != null) {
      const box = await page.locator("img").first().boundingBox();
      if (box) {
        await page.mouse.click(
          box.x + (action.x_pct / 100) * box.width,
          box.y + (action.y_pct / 100) * box.height
        );
      }
    } else if (action.action === "type" && action.text) {
      await page.keyboard.type(action.text);
      await page.keyboard.press("Enter");
    } else if (action.action === "wait") {
      await page.waitForTimeout(1500);
    } else if (action.action === "done") {
      trace.push({
        step,
        action,
        dwell_ms: Date.now() - stepStart,
        url: page.url(),
        screenshot: shotPath,
      });
      break;
    }

    await page.waitForTimeout(800);
    trace.push({
      step,
      action,
      dwell_ms: Date.now() - stepStart,
      url: page.url(),
      screenshot: shotPath,
    });
  }

  // Final-state check: screenshot the end screen and let the VLM judge the goal.
  const finalShot = path.join(runDir, "final.png");
  await page.screenshot({ path: finalShot });
  const goalVerdict: GoalVerdict = LIVE
    ? await verifyGoal((await readFile(finalShot)).toString("base64"), task.goal)
    : { achieved: false, why: "dry-run" };

  const criteriaPass = evaluateSuccess(task, page.url(), trace);
  // Success requires BOTH the URL/step criteria and the VLM goal verdict when
  // live; dry-runs fall back to criteria only (no VLM available).
  const success = LIVE ? criteriaPass && goalVerdict.achieved : criteriaPass;
  const friction = computeFriction(trace);
  await browser.close();

  return {
    task_id: task.id,
    success,
    criteria_pass: criteriaPass,
    goal_verdict: goalVerdict,
    friction,
    final_url: page.url(),
    final_screenshot: finalShot,
    steps: trace.length,
    total_ms: Date.now() - t0,
    trace,
    dimension: "ux_understand",
  };
}

async function main() {
  await loadEnv();
  // Optional cost control: UX_BENCH_TASKS=first_query,first_world_enter runs
  // only those task ids (each task spends on generation + VLM steps).
  const only = process.env.UX_BENCH_TASKS?.split(",").map((s) => s.trim()).filter(Boolean);
  const tasks = (await loadTasks()).filter((t) => !only || only.includes(t.id));
  console.log(`ux-bench: ${tasks.length} tasks (live=${LIVE})`);
  for (const t of tasks) {
    console.log(`  - ${t.id}: ${t.goal.slice(0, 60)}…`);
  }

  if (!LIVE) {
    console.log("\nDry-run only. Set UX_BENCH_RUN=1 to run the agent loop.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(REPORTS_DIR, `ux-${stamp}`);
  await mkdir(runDir, { recursive: true });

  const results: Array<Record<string, unknown>> = [];
  for (const task of tasks) {
    const taskDir = path.join(runDir, task.id);
    await mkdir(taskDir, { recursive: true });
    console.log(`\n▶ ${task.id}`);
    const result = await runTask(task, taskDir);
    results.push(result);
    const f = result.friction as Friction;
    const v = result.goal_verdict as GoalVerdict;
    console.log(`  success=${result.success} steps=${result.steps}`);
    console.log(
      `    friction: slowest=step ${f.slowest_step} (${f.slowest_ms}ms), ` +
        `revisits=${f.revisits}, stuck=${f.stuck_runs}`
    );
    console.log(`    goal: ${v.achieved ? "ACHIEVED" : "NOT achieved"} — ${v.why}`);
  }

  const summary = {
    run_at: stamp,
    n_tasks: results.length,
    success_rate: results.filter((r) => r.success).length / results.length,
    results,
  };
  await writeFile(path.join(runDir, "trace.json"), JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${path.join(runDir, "trace.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
