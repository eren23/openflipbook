/** Explicit growth harness; default invocation is a read-only quote preflight. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";
import { quoteHash, validateEnvironment, validateQuote } from "../../../scripts/selfhost/quality-pilot.mjs";
import { jsonHash, sha256 } from "./run-quality-pilot.mjs";
import { GROWTH_AREAS, validateGrowthQuote, reserveGrowth, prepareGrowthAction, runGrowthArea } from "./quality-pilot-growth.mjs";

const expect = baseExpect.configure({ timeout: 60_000 });
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
function originalFingerprint(manifest) {
  const reviews = Object.fromEntries(Object.entries(manifest.reviews ?? {}).filter(([key]) => key !== "growth"));
  return jsonHash({ phases: manifest.phases, world: manifest.world, build_id: manifest.build_id, expansion: manifest.expansion,
    request_ids: manifest.request_ids, reviews, actions: Object.fromEntries(Object.entries(manifest.actions).filter(([key]) => !key.startsWith("growth-"))) });
}
async function stopOwned(receipt, environment) {
  const config = JSON.parse(await readFile(receipt.compose_file, "utf8")); assert.equal(quoteHash(config), receipt.compose_sha256); assert.equal(config.name, receipt.project);
  const root = resolve(dirname(environment), "../../../.."), clean = Object.fromEntries(["PATH", "HOME", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const run = args => new Promise((accept, reject) => { const child = spawn("docker", ["compose", "--env-file", "/dev/null", "--project-name", receipt.project, "--project-directory", root, "--file", receipt.compose_file, ...args], { cwd: root, env: clean, stdio: ["ignore", "pipe", "pipe"] }); child.stdout.resume(); child.stderr.resume(); child.once("error", reject); child.once("close", code => code === 0 ? accept() : reject(new Error(`Owned pilot stop failed (${code}); stores retained`))); });
  await run(["stop", "--timeout", "360", "place-worker"]); await run(["stop", "web", "backend", "mongo", "minio"]);
  receipt.state = "failed_stopped"; receipt.stopped_at = new Date().toISOString(); await atomicJson(environment, receipt);
}

export async function runGrowth({ environment, approval, phase, execute = false, allowRun }) {
  assert.ok(Object.hasOwn(GROWTH_AREAS, phase), "Growth phase is west or north"); environment = resolve(environment); approval = resolve(approval);
  const receipt = validateEnvironment(JSON.parse(await readFile(environment, "utf8")), environment); validateQuote(receipt.quote);
  assert.equal(receipt.state, "running"); const directory = receipt.evidence_dir;
  for (const path of [directory, environment, approval]) { const info = await lstat(path); assert.equal(info.isSymbolicLink(), false); assert.equal(info.mode & 0o077, 0, "Private pilot evidence required"); }
  assert.equal(dirname(approval), directory, "Keep extension approval beside its retained pilot evidence");
  const quote = validateGrowthQuote(receipt, JSON.parse(await readFile(approval, "utf8")), execute), manifestPath = join(directory, "pilot-manifest.json");
  const initial = JSON.parse(await readFile(manifestPath, "utf8")); assert.equal(initial.world.session_id, quote.session_id); assert.equal(initial.project, receipt.project);
  if (!execute) return console.log(JSON.stringify({ prepared: true, approved: quote.approval?.approved === true, parent_quote_sha256: receipt.quote_sha256, extension_quote_sha256: jsonHash(quote), cumulative_envelope_usd: quote.cumulative_envelope_usd, model_calls: 0, manifest_changes: 0 }));
  assert.equal(allowRun, jsonHash(quote), "Explicit approved extension hash required");
  const harness = await open(join(directory, "harness.lock"), "wx", 0o600).catch(() => { throw new Error("Another lifecycle action owns this pilot; no concurrent execution"); });
  const lock = join(directory, ".quality-pilot.lock"); let driverLock = false, browser, context, page, manifest, run;
  try {
    await mkdir(lock, { mode: 0o700 }); driverLock = true;
    const currentReceipt = JSON.parse(await readFile(environment, "utf8")); assert.equal(currentReceipt.state, "running"); assert.equal(currentReceipt.quote_sha256, receipt.quote_sha256);
    manifest = JSON.parse(await readFile(manifestPath, "utf8")); const original = originalFingerprint(manifest), extension = reserveGrowth(manifest, receipt, quote);
    run = `growth-${phase}-${Date.now()}-${randomUUID().slice(0, 8)}`; extension.runs ??= []; extension.runs.push({ id: run, phase, status: "running", started_at: new Date().toISOString() });
    const state = manifest.extension_phases[`growth_${phase}`]; state.status = state.status === "complete" ? state.status : "running";
    const persist = async () => { assert.equal(originalFingerprint(manifest), original, "Growth changed original receipts or actions"); await atomicJson(manifestPath, manifest); };
    const save = (label, value) => atomicJson(join(directory, `growth-${phase}-${label}.json`), value);
    const log = async (event, detail = {}) => { const line = JSON.stringify({ at: new Date().toISOString(), run, event, ...detail }); console.log(line); await appendFile(join(directory, "terminal.jsonl"), line + "\n", { mode: 0o600 }); };
    await atomicJson(join(lock, "owner.json"), { pid: process.pid, run, phase: `growth_${phase}` }); await persist(); await log("growth_reserved", { cumulative_envelope_usd: quote.cumulative_envelope_usd, original_quote_sha256: receipt.quote_sha256, extension_quote_sha256: jsonHash(quote) });
    const storageState = JSON.parse(await readFile(join(directory, "browser-state.json"), "utf8"));
    browser = await chromium.launch({ headless: true, slowMo: 100 }); context = await browser.newContext({ baseURL: receipt.origin, storageState, viewport: { width: 1280, height: 900 }, recordVideo: { dir: join(directory, "uncut-video"), size: { width: 1280, height: 900 } } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); page = await context.newPage(); page.setDefaultTimeout(60_000);
    const errors = [], approvedUiWrites = new Map(); page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => { const request = route.request(); if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue(); const path = new URL(request.url()).pathname, handler = approvedUiWrites.get(path); if (!handler) { await log("blocked_unapproved_browser_write", { path }); return route.abort(); } await handler(route, request.postDataJSON()); });
    const get = async path => { assert.ok(path.startsWith(`/api/world/${manifest.world.session_id}/`)); const response = await page.request.get(path, { maxRedirects: 0 }); assert.ok(response.ok(), `Product read failed ${response.status()}`); return response.json(); };
    const post = async (name, path, body, reservation = 0) => {
      assert.ok(path.startsWith(`/api/world/${manifest.world.session_id}/places/`)); const action = prepareGrowthAction(manifest, phase, name, path, body, reservation); await persist();
      const responseFile = join(directory, `growth-${phase}-${name}-response.json`);
      if (action.status === "acknowledged") { const text = await readFile(responseFile, "utf8"); assert.equal(sha256(text), action.response_sha256); assert.deepEqual(JSON.parse(text), action.response); return action.response; }
      action.status = "sent"; action.sent_at = new Date().toISOString(); await persist(); await log("product_request", { name, path, reservation_usd: reservation });
      try { const response = await page.request.post(path, { data: body, maxRedirects: 0, timeout: 180_000 }), text = await response.text(); action.http_status = response.status(); action.response_sha256 = sha256(text); await writeFile(responseFile, text, { mode: 0o600 }); action.response = JSON.parse(text); action.status = response.ok() ? "acknowledged" : "rejected"; await persist(); assert.ok(response.ok(), `Growth request rejected ${response.status()}: ${action.response.error ?? name}`); return action.response; }
      catch (error) { if (action.status === "sent") action.status = "unknown"; await persist(); throw error; }
    };
    const ready = async () => { const viewports = page.getByTestId("place-viewport"); await expect(viewports.first()).toBeVisible(); for (const viewport of await viewports.all()) await expect(viewport).toHaveAttribute("data-ready", "true"); };
    const screen = async label => { await ready(); await page.screenshot({ path: join(directory, `${run}-${label}.png`), fullPage: false }); };
    await runGrowthArea({ phase, manifest, quote, page, get, post, persist, ready, screen, save, approvedUiWrites }); assert.deepEqual(errors, [], "Actual browser errors occurred");
    extension.runs.at(-1).status = state.status; extension.runs.at(-1).completed_at = new Date().toISOString(); await persist(); await log(state.status === "complete" ? "growth_applied" : "growth_awaiting_actual_proposal_review", state.result);
  } catch (error) {
    if (manifest && run) { const state = manifest.extension_phases[`growth_${phase}`]; state.status = "needs_review"; state.error = error.message; manifest.extensions.growth.runs.at(-1).status = "needs_review"; await atomicJson(manifestPath, manifest); }
    if (page) await page.screenshot({ path: join(directory, `${run}-failure.png`) }).catch(() => {});
    if (driverLock) await stopOwned(receipt, environment); throw error;
  } finally {
    if (context) { await context.tracing.stop({ path: join(directory, `${run}-trace.zip`) }).catch(() => {}); await context.close(); } if (browser) await browser.close();
    if (driverLock) await rm(lock, { recursive: true }); await harness.close(); await unlink(join(directory, "harness.lock"));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (args.includes("--help")) console.log("run-quality-pilot-growth.mjs --environment <retained private environment> --approval <separate growth quote> --phase west|north [--execute --allow-run <extension hash>]\nDefault is a read-only preflight. Each actual generated proposal requires manifest.reviews.growth.<area> with approved:true, proposal_id, definition_sha256, reviewed_at before apply. Original quote/actions remain unchanged.");
  else { assert.ok(value("--environment") && value("--approval") && value("--phase")); await runGrowth({ environment: value("--environment"), approval: value("--approval"), phase: value("--phase"), execute: args.includes("--execute"), allowRun: value("--allow-run") }); }
}
