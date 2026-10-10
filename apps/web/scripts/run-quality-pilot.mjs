/** Opt-in product quality pilot. A private, current quote precedes every paid phase. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";

export const PHASES = ["layout", "appearance", "capture", "illustration", "furnishing", "edit", "expansion", "motion", "replay"];
export const pilotBrowserSlowMo = phase => ["capture", "replay"].includes(phase) ? 0 : 100;
export const LAYOUT_PROMPT = `Create a small asymmetric, walkable district inside the saved 40 by 40 authored metres. Keep the saved dimensions and entrance. Use no more than 12 objects and exactly three structured buildings: Copper Workshop, a two-storey landmark with a teal roof, one exterior doorway, two rooms on its ground floor, a reachable upper room and a straight staircase; a smaller single-storey bakery west of it; and a distinct single-storey bookshop northeast. Keep open circulation from the entrance to every doorway, around the buildings, and through both workshop floors. Place the workshop away from the east boundary to permit a later one-metre eastward move. Avoid symmetry and retain clear gaps between buildings.
Request exactly two generated meshes as new volume envelopes: one small carved wooden chair as a floor-bound interior prop inside the upper workshop room, and one complete low-poly exterior garden kiosk shell on outdoor ground, solid and non-enterable. Do not replace structured buildings, doors or stairs with meshes. Use meshes roles prop and exterior, one request for each. Use at most three material requests, reusing a warm limestone wall tile across the three buildings, a teal ceramic roof tile, and a wooden interior floor tile on the workshop. Each interior object must use the correct generated building and floor IDs. Return the provider's ordinary JSON keys objects, materials and meshes, with valid dimensions, doors, stairs, rooms and circulation. No extra generation requests.`;
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const jsonHash = value => sha256(JSON.stringify(value));
const expect = baseExpect.configure({ timeout: 60_000 });
const micros = value => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid reservation");
  const result = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(result) || Math.abs(result / 1_000_000 - value) > 1e-9) throw new Error("Reservation needs at most six decimal places");
  return result;
};

export function validateEnvironment(receipt, phase) {
  const origin = new URL(receipt.origin);
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, "quality-pilot");
  assert.match(receipt.project, /^ofb-pilot-[a-f0-9]{12}$/);
  assert.equal(receipt.database, "quality_pilot"); assert.equal(receipt.live_providers, true); assert.equal(receipt.fixture_providers, false);
  assert.equal(receipt.state, "running"); assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
  assert.equal(origin.username, ""); assert.equal(origin.password, ""); assert.equal(origin.pathname, "/");
  assert.equal(origin.search, ""); assert.equal(origin.hash, ""); assert.ok(origin.port);
  assert.ok(PHASES.includes(phase), "Unknown pilot phase"); assert.ok(receipt.approved_phases?.includes(phase), "Phase is not approved");
  assert.equal(receipt.quote_sha256, jsonHash(receipt.quote), "Quote bytes changed");
  assert.equal(receipt.cap_usd, 5); assert.equal(receipt.quote.cap_usd, receipt.cap_usd);
  assert.ok(receipt.evidence_dir && resolve(receipt.evidence_dir) === receipt.evidence_dir, "Absolute private evidence directory required");
  assert.ok(receipt.quote.phases?.[phase], "Current phase quote missing");
  assert.ok(Number.isFinite(Date.parse(receipt.quote.expires_at)) && Date.parse(receipt.quote.expires_at) > Date.now(), "Quote expired; verify current prices before continuing");
  for (const quote of Object.values(receipt.quote.phases)) micros(quote.max_reservation);
  assert.ok(Object.values(receipt.quote.phases).reduce((sum, quote) => sum + micros(quote.max_reservation), 0) <= micros(receipt.cap_usd), "Quoted phase envelope exceeds cumulative cap");
  return receipt;
}

export function reservedPilotUsd(manifest) {
  return [...Object.values(manifest.phases), ...Object.values(manifest.extension_phases ?? {})]
    .reduce((sum, item) => sum + micros(item.reserved_usd), 0) / 1_000_000;
}

export function reservePhase(manifest, phase, approval, quoteHash) {
  const total = micros(reservedPilotUsd(manifest));
  if (total > micros(manifest.cap_usd)) throw new Error("Cumulative pilot envelope exhausted; no request allowed");
  const old = manifest.phases[phase];
  if (old) { assert.deepEqual(old.approval, approval, "Reserved phase quote changed"); return old; }
  if (total + micros(approval.max_reservation) > micros(manifest.cap_usd)) throw new Error("Cumulative pilot envelope exhausted; no request allowed");
  const saved = { approval: structuredClone(approval), quote_sha256: quoteHash, reserved_usd: approval.max_reservation, status: "reserved", created_at: new Date().toISOString() };
  manifest.phases[phase] = saved; return saved;
}

export function checkQuote(current, approved, name) {
  if (!current?.enabled || !approved || current.model !== approved.model || micros(current.reservation) !== micros(approved.reservation)) throw new Error(`${name} capability or quote changed; no paid request allowed`);
  if (approved.parameters !== undefined) assert.deepEqual(current.parameters, approved.parameters, `${name} parameters changed`);
  return { model: current.model, reservation: current.reservation, ...(current.parameters ? { parameters: current.parameters } : {}) };
}

export function checkTextQuote(current, approved, name) {
  // These backends advertise model/reservation; their one SDK call has a
  // hardcoded 16384-token ceiling, independent of image/mesh parameters.
  assert.deepEqual(approved?.parameters, { max_tokens: 16384 }, "Text token ceiling changed");
  return checkQuote(current, { model: approved.model, reservation: approved.reservation }, name);
}

export function validatePlan(job, definition) {
  const materials = job.material_plan ?? [], meshes = job.mesh_plan ?? [];
  if (materials.length < 1 || materials.length > 3 || meshes.length !== 2 || new Set(meshes.map(item => item.role)).size !== 2 || !meshes.some(item => item.role === "prop") || !meshes.some(item => item.role === "exterior")) throw new Error("Pilot needs 1–3 materials and exactly one prop plus one exterior mesh; preserve layout for review");
  if (definition) {
    assert.equal(definition.width, 40); assert.equal(definition.depth, 40); assert.ok(definition.objects.length <= 12);
    const buildings = definition.objects.filter(object => object.kind === "building");
    assert.equal(buildings.length, 3, "Pilot needs three structured buildings");
    const landmark = buildings.find(object => object.label === "Copper Workshop");
    assert.ok(landmark?.structure?.floors.length === 2, "Pilot landmark needs two structured floors");
    // The normal product validator already checks its explicit or derived
    // default stair and circulation. Do not demand a non-schema stairs list.
    const upper = landmark.structure.floors[1].id;
    const prop = meshes.find(item => item.role === "prop");
    assert.ok(prop.targets.some(target => definition.objects.some(object => object.id === target.object_id && object.placement?.building_id === landmark.id && object.placement?.floor_id === upper)), "Prop must bind to the landmark upper floor");
    const exterior = meshes.find(item => item.role === "exterior");
    assert.ok(exterior.targets.every(target => definition.objects.some(object => object.id === target.object_id && !object.placement)), "Exterior mesh must stay on outdoor ground");
  }
  return { materials: materials.length, meshes: meshes.length };
}

export function prepareAction(manifest, phase, name, path, body, reservation = 0) {
  const key = `${phase}:${name}`, input_sha256 = jsonHash([path, body]);
  const old = manifest.actions[key];
  if (old) { assert.equal(old.input_sha256, input_sha256, "Saved action identity changed"); assert.equal(old.reserved_usd, reservation); return old; }
  const total = Object.values(manifest.actions).filter(action => action.phase === phase).reduce((sum, action) => sum + micros(action.reserved_usd), 0);
  if (total + micros(reservation) > micros(manifest.phases[phase].reserved_usd)) throw new Error("Phase reservation exhausted; no request allowed");
  const action = { phase, name, path, body: structuredClone(body), input_sha256, reserved_usd: reservation, status: "prepared", created_at: new Date().toISOString() };
  manifest.actions[key] = action; return action;
}

export function checkTextContext(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 20_000) throw new Error("Text planning context exceeds the approved 20KB bound; no LLM request allowed");
}

export function requireReview(review, definitionHash, label) {
  assert.ok(review?.approved === true && review.definition_sha256 === definitionHash && Number.isFinite(Date.parse(review.reviewed_at)), `${label} needs a recorded review of these exact bytes`);
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`; const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function optionalJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; return null; } }
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export async function runPilot({ environment, phase }) {
  const receipt = validateEnvironment(JSON.parse(await readFile(resolve(environment), "utf8")), phase), directory = receipt.evidence_dir;
  if ((await stat(resolve(environment))).mode & 0o077) throw new Error("Environment receipt must be private (0600)");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const lock = join(directory, ".quality-pilot.lock"); await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error("Another pilot owns the durable run lock. Reconcile it before continuing."); });
  let browser, context, page; const run = `${phase}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const log = async (event, detail = {}) => {
    const entry = { at: new Date().toISOString(), phase, event, ...detail }; const line = JSON.stringify(entry);
    console.log(line); await appendFile(join(directory, "terminal.jsonl"), `${line}\n`, { mode: 0o600 });
  };
  const manifestPath = join(directory, "pilot-manifest.json");
  let manifest;
  try {
    manifest = await optionalJson(manifestPath) ?? { version: 1, project: receipt.project, origin: receipt.origin, database: receipt.database, cap_usd: receipt.cap_usd, phases: {}, actions: {}, request_ids: {}, runs: [] };
    for (const key of ["project", "origin", "database", "cap_usd"]) assert.equal(manifest[key], receipt[key], "Pilot environment changed");
    const phaseState = reservePhase(manifest, phase, receipt.quote.phases[phase], receipt.quote_sha256);
    await atomicJson(manifestPath, manifest);
    await atomicJson(join(lock, "owner.json"), { pid: process.pid, run, phase, created_at: new Date().toISOString() });
    await log("phase_reserved", { ceiling_usd: phaseState.reserved_usd, cumulative_reserved_usd: reservedPilotUsd(manifest) });
    const runState = { id: run, phase, started_at: new Date().toISOString(), status: "running" }; manifest.runs.push(runState); await atomicJson(manifestPath, manifest);
    const statePath = join(directory, "browser-state.json"), savedState = await optionalJson(statePath);
    if (manifest.world && !savedState) throw new Error("Saved browser ownership is missing; never create a replacement world");
    // Delaying each keyboard/observation RPC makes continuous walking overshoot
    // real collision waypoints. Capture/replay use explicit recording waits.
    browser = await chromium.launch({ headless: true, slowMo: pilotBrowserSlowMo(phase) });
    context = await browser.newContext({ baseURL: receipt.origin, viewport: { width: 1280, height: 900 }, ...(savedState ? { storageState: savedState } : {}), recordVideo: { dir: join(directory, "uncut-video"), size: { width: 1280, height: 900 } } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); page = await context.newPage(); page.setDefaultTimeout(60_000);
    const errors = [], approvedUiWrites = new Map(); page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const request = route.request(); if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue();
      const path = new URL(request.url()).pathname, body = request.postDataJSON();
      const handler = approvedUiWrites.get(path);
      if (!handler) { await log("blocked_unapproved_browser_write", { path }); return route.abort(); }
      await handler(route, body);
    });
    const persist = () => atomicJson(manifestPath, manifest);
    // Resolve the async storage state before serialization; cookies never enter logs.
    const saveOwnership = async () => atomicJson(statePath, await context.storageState());
    const id = async name => { manifest.request_ids[name] ??= randomUUID(); await persist(); return manifest.request_ids[name]; };
    const get = async path => {
      assert.ok(path.startsWith("/api/")); const response = await page.request.get(path, { maxRedirects: 0 });
      if (!response.ok()) throw new Error(`Product read failed ${response.status()} at ${path}`); return response.json();
    };
    const post = async (name, path, body, reservation = 0) => {
      const action = prepareAction(manifest, phase, name, path, body, reservation); await persist();
      if (action.status === "acknowledged") {
        const text = await readFile(join(directory, `${phase}-${name}-response.json`), "utf8");
        assert.equal(sha256(text), action.response_sha256, "Saved product acknowledgement bytes changed");
        const response = JSON.parse(text); assert.deepEqual(response, action.response); return response;
      }
      if (action.status === "sent" || action.status === "unknown" || action.status === "rejected") throw new Error(`Action ${name} needs explicit reconciliation; no automatic retry`);
      action.status = "sent"; action.sent_at = new Date().toISOString(); await persist(); await log("product_request", { name, path, reservation_usd: reservation });
      try {
        const response = await page.request.post(path, { data: body, maxRedirects: 0, timeout: 180_000 }), text = await response.text();
        action.http_status = response.status(); action.response_sha256 = sha256(text);
        await writeFile(join(directory, `${phase}-${name}-response.json`), text, { mode: 0o600 });
        action.response = JSON.parse(text); action.status = response.ok() ? "acknowledged" : "rejected";
        await saveOwnership(); await persist(); if (!response.ok()) throw new Error(`Product request rejected ${response.status()}: ${action.response.error ?? name}`);
        return action.response;
      } catch (error) { if (action.status === "sent") action.status = "unknown"; await persist(); throw error; }
    };
    const scenePath = () => `/api/world/${manifest.world.session_id}/places/${manifest.world.place_id}/scene`;
    const buildPath = () => `/api/world/${manifest.world.session_id}/places/${manifest.world.place_id}/build`;
    const viewsPath = () => `/api/world/${manifest.world.session_id}/places/${manifest.world.place_id}/views`;
    const ready = async () => { const viewports = page.getByTestId("place-viewport"); await expect(viewports.first()).toBeVisible(); for (const viewport of await viewports.all()) await expect(viewport).toHaveAttribute("data-ready", "true"); };
    const navigate = async mode => { await page.goto(`/sketch/world?world=${manifest.world.session_id}&place=${manifest.world.place_id}&view=${mode}`, { waitUntil: "domcontentloaded" }); await ready(); };
    const button = name => page.getByRole("button", { name, exact: true });
    const captureScreen = async label => { await ready(); await page.screenshot({ path: join(directory, `${run}-${label}.png`), fullPage: false }); };
    const readScene = async () => { const data = await get(scenePath()); return data.scene ?? data; };
    const waitForJob = async (path, jobId, appearance = false) => {
      const end = Date.now() + (appearance ? 25 * 60_000 : 5 * 60_000); let previous;
      for (;;) {
        const library = await get(path), job = library.jobs.find(item => item.id === jobId); assert.ok(job, "Saved job missing");
        await atomicJson(join(directory, `${phase}-saved-library.json`), library);
        const statuses = appearance ? [job.material_stage, job.mesh_stage].filter(Boolean).flatMap(stage => stage.items.map(item => item.job.status)) : [job.status];
        const key = statuses.join(","); if (previous !== key) { await log("saved_job_status", { id: jobId, status: key }); previous = key; }
        if (statuses.some(status => ["invalid", "failed", "cancelled", "submission_unknown", "storage_failed", "blocked", "needs_review"].includes(status))) throw new Error(`Saved job needs review: ${key}; original work and reservations retained`);
        if (appearance ? statuses.length && statuses.every(status => status === "ready") : job.status === "ready") return { library, job };
        if (Date.now() > end) throw new Error("Saved provider work remains pending; no retry or replacement submitted");
        await page.waitForTimeout(5000);
      }
    };
    const preview = async (layoutOnly, label) => {
      await navigate("orbit"); const panel = page.getByRole("region", { name: "AI place layout", exact: true });
      await panel.getByRole("button", { name: "Refresh layout jobs", exact: true }).click();
      const name = layoutOnly ? "Preview layout only" : "Preview complete appearance";
      let proposal;
      approvedUiWrites.set(buildPath(), async (route, body) => {
        assert.equal(body.action, "preview"); assert.equal(body.id, manifest.build_id); assert.equal(body.layout_only === true, layoutOnly);
        const response = await route.fetch(), text = await response.text(); if (!response.ok()) throw new Error(`Preview rejected ${response.status()}: ${text}`);
        proposal = JSON.parse(text).proposal; await atomicJson(join(directory, `${phase}-${label}-proposal.json`), proposal);
        phaseState.preview = { id: proposal.id, definition_sha256: jsonHash(proposal.definition) }; await persist(); await route.fulfill({ response, body: text });
      });
      await panel.getByRole("button", { name, exact: true }).click(); await expect(page.getByRole("region", { name: "World change preview" })).toBeVisible();
      assert.ok(proposal, "Actual UI preview acknowledgement missing"); await captureScreen(label); return proposal;
    };
    const downloadAssets = async () => {
      const sid = manifest.world.session_id, artifacts = [];
      for (const [kind, plural, field, extension] of [["material", "materials", "assets", "jpg"], ["mesh", "meshes", "saved_meshes", "glb"]]) {
        const library = await get(`/api/world/${sid}/${plural}`); await atomicJson(join(directory, `${phase}-${plural}-library.json`), library);
        for (const asset of library[field]) {
          assert.ok(safeId(asset.id)); const response = await page.request.get(`/api/world/${sid}/${plural}/${asset.id}`, { maxRedirects: 0 }); assert.equal(response.status(), 200);
          const bytes = await response.body(); assert.equal(sha256(bytes), asset.sha256, "Owned asset bytes changed");
          const file = `${asset.id}.${asset.sha256}.${extension}`; await writeFile(join(directory, file), bytes, { mode: 0o600 }); artifacts.push({ kind, id: asset.id, model: asset.model, sha256: asset.sha256, bytes: bytes.length, file });
        }
      }
      await atomicJson(join(directory, `${phase}-asset-receipts.json`), artifacts); return artifacts;
    };
    const snapshot = async label => {
      const scene = await readScene(), map = await get(`/api/world/${manifest.world.session_id}/map`);
      await atomicJson(join(directory, `${phase}-${label}-scene.json`), scene); await atomicJson(join(directory, `${phase}-${label}-map.json`), map);
      phaseState.scene = { revision: scene.revision, sha256: jsonHash(scene.definition), object_ids: scene.definition.objects.map(object => object.id) }; await persist(); return scene;
    };

    if (phase === "layout") {
      const empty = { version: 2, label: "Copper Workshop quality pilot", width: 40, depth: 40, units: "authored_metres", entrance: { x: 20, z: 38.8, yaw: 0 }, objects: [] };
      if (!manifest.world) {
        await post("identity", "/api/creator/identity", {});
        const request_id = await id("create-world"), created = await post("create-world", "/api/creator/worlds", { request_id, definition: empty });
        manifest.world = { session_id: created.session_id, place_id: created.place_id }; await persist(); await saveOwnership();
      }
      await navigate("plan"); const scene = await readScene(), library = await get(buildPath()), quote = checkTextQuote(library.capabilities, phaseState.approval.models.layout, "Layout");
      if (!manifest.build_id) { assert.equal(scene.revision, 1); assert.deepEqual(scene.definition, empty); manifest.build_id = await id("layout"); await persist(); }
      checkTextContext({ request: LAYOUT_PROMPT, saved_place: scene.definition, connection_input: { version: 1, place_id: manifest.world.place_id, connections: [] } });
      await page.getByRole("textbox", { name: "Place description", exact: true }).fill(LAYOUT_PROMPT);
      await captureScreen("layout-quote");
      await post("queue", buildPath(), { action: "queue", id: manifest.build_id, prompt: LAYOUT_PROMPT, confirmed: true, model: quote.model, reservation: quote.reservation, base_revision: 1 }, quote.reservation);
      await post("run", buildPath(), { action: "run", id: manifest.build_id });
      const result = await waitForJob(buildPath(), manifest.build_id); validatePlan(result.job);
      const proposal = await preview(true, "layout-preview"); validatePlan(result.job, proposal.definition);
      phaseState.result = { build_id: manifest.build_id, layout_sha256: jsonHash(proposal.definition), counts: validatePlan(result.job, proposal.definition) };
      await snapshot("unapplied"); await log("layout_ready_for_review", phaseState.result);
    } else {
      assert.ok(manifest.world && manifest.build_id && manifest.phases.layout?.status === "complete", "Complete and review the saved layout first");
      await navigate("orbit");
      if (phase === "appearance") {
        const result = await waitForJob(buildPath(), manifest.build_id), counts = validatePlan(result.job);
        const material = checkQuote(result.library.material_capabilities, phaseState.approval.models.material, "Material"), mesh = checkQuote(result.library.mesh_capabilities, phaseState.approval.models.mesh, "Mesh");
        const total = (micros(material.reservation) * counts.materials + micros(mesh.reservation) * counts.meshes) / 1_000_000;
        assert.ok(micros(total) <= micros(phaseState.reserved_usd), "Complete appearance exceeds the approved envelope");
        phaseState.reviewed_layout_sha256 = manifest.phases.layout.result.layout_sha256; await persist(); await captureScreen("appearance-quote");
        await post("appearance", buildPath(), { action: "appearance", id: manifest.build_id, request_id: await id("appearance"), confirmed: true, total_reservation: total, quotes: { material, mesh } }, total);
        const completed = await waitForJob(buildPath(), manifest.build_id, true); assert.equal(completed.job.material_stage.items.length, counts.materials); assert.equal(completed.job.mesh_stage.items.length, counts.meshes);
        const proposal = await preview(false, "complete-appearance-preview");
        assert.equal(proposal.definition.objects.filter(object => object.kind === "mesh").length, 2);
        phaseState.result = { definition_sha256: jsonHash(proposal.definition), counts, artifacts: await downloadAssets() };
        await log("appearance_ready_for_review", { definition_sha256: phaseState.result.definition_sha256, asset_count: phaseState.result.artifacts.length });
      } else if (phase === "capture") {
        assert.equal(manifest.phases.appearance?.status, "complete", "Review complete appearance before applying");
        requireReview(manifest.reviews?.appearance, manifest.phases.appearance.result.definition_sha256, "Complete appearance");
        const previousPerformance = phaseState.scene?.sha256 === manifest.phases.appearance.result.definition_sha256
          ? phaseState.result?.performance : undefined;
        let scene = await readScene();
        if (scene.revision === 1) {
          const proposal = await preview(false, "appearance-apply-preview"); assert.equal(jsonHash(proposal.definition), manifest.phases.appearance.result.definition_sha256);
          const body = { action: "apply", proposal_id: proposal.id }, action = prepareAction(manifest, phase, "apply", scenePath(), body);
          await persist(); approvedUiWrites.set(scenePath(), async (route, sent) => {
            assert.deepEqual(sent, body); if (action.status !== "prepared") throw new Error("Apply acknowledgement needs reconciliation");
            action.status = "sent"; await persist(); const response = await route.fetch(), text = await response.text(); action.http_status = response.status(); action.response = JSON.parse(text); action.response_sha256 = sha256(text);
            action.status = response.ok() ? "acknowledged" : "rejected"; await writeFile(join(directory, "capture-apply-response.json"), text, { mode: 0o600 }); await persist(); await route.fulfill({ response, body: text });
          });
          await button("Apply to world").click(); await expect(page.getByRole("status").filter({ hasText: /^Revision 2/ })).toHaveText("Revision 2 · Saved"); await ready(); scene = await readScene();
        }
        assert.equal(jsonHash(scene.definition), manifest.phases.appearance.result.definition_sha256, "Applied scene differs from the reviewed appearance");
        await page.setViewportSize({ width: 1024, height: 820 }); await navigate("orbit");
        const landmark = scene.definition.objects.find(object => object.label === "Copper Workshop"); assert.ok(landmark);
        await button(`${landmark.label} building`).click(); await button("Frame selected in 3D").click(); await ready();
        const viewId = await id("capture-view");
        if (!manifest.capture_view_id) {
          const panel = page.getByRole("region", { name: "Saved camera views", exact: true }); await panel.getByRole("textbox", { name: "View name", exact: true }).fill("Pilot workshop camera");
          approvedUiWrites.set(viewsPath(), async (route, original) => {
            const body = { ...original, id: viewId }; assert.ok(body.capture.width <= 768 && body.capture.height <= 768, "Capture exceeds the approved 768px input bounds");
            const action = prepareAction(manifest, phase, "save-view", viewsPath(), body); await persist();
            if (action.status !== "prepared") throw new Error("Capture acknowledgement needs reconciliation; do not mint another camera");
            action.status = "sent"; await persist(); const response = await route.fetch({ postData: JSON.stringify(body) }), text = await response.text();
            action.response = JSON.parse(text); action.http_status = response.status(); action.response_sha256 = sha256(text); action.status = response.ok() ? "acknowledged" : "rejected";
            await writeFile(join(directory, "capture-save-view-response.json"), text, { mode: 0o600 }); if (response.ok()) manifest.capture_view_id = viewId; await persist(); await route.fulfill({ response, body: text });
          });
          await panel.getByRole("button", { name: "Save camera view", exact: true }).click(); await expect(panel.getByRole("status").filter({ hasText: /^Current geometry/ })).toBeVisible();
        }
        const views = await get(viewsPath()), view = views.views.find(item => item.id === viewId); assert.ok(view && !view.historical); assert.ok(view.width <= 768 && view.height <= 768);
        await atomicJson(join(directory, "capture-saved-view.json"), view);
        for (const pass of ["render", "depth", "normals", "objects"]) {
          const response = await page.request.get(`/api/world/${manifest.world.session_id}/views/${viewId}/${pass}`, { maxRedirects: 0 }); assert.equal(response.status(), 200);
          const bytes = await response.body(); await writeFile(join(directory, `capture-${viewId}-${pass}.${sha256(bytes)}.png`), bytes, { mode: 0o600 });
        }
        phaseState.result = { view_id: viewId, artifacts: await downloadAssets() }; await snapshot("applied"); await captureScreen("saved-3d");
        const { measureWorldPerformance } = await import("./quality-pilot-performance.mjs");
        phaseState.result.performance = previousPerformance ?? await measureWorldPerformance(page, directory); await persist();
        const { verifyPilotWalk } = await import("./quality-pilot-walk.mjs");
        phaseState.result.walk = await verifyPilotWalk({ page, manifest, directory, approvedUiWrites, get, navigate, readScene, log, atomicJson }); await persist();
        assert.equal(phaseState.result.walk.status, "passed", "Real interior walking needs review; preserve the saved appearance and capture");
      } else if (phase === "replay") {
        assert.equal(manifest.phases.capture?.status, "complete", "Replay must reopen the applied and captured world");
        const { verifySavedPilotMedia, readPilotReplayNetwork, assertPilotReplayNetworkUnchanged } = await import("./quality-pilot-replay.mjs");
        const networkBefore = await readPilotReplayNetwork({ manifest, get });
        await atomicJson(join(directory, "replay-network-before.json"), networkBefore);
        const before = await readScene(), beforeLibrary = await get(buildPath()); await navigate("orbit"); await captureScreen("reopened-3d"); await navigate("plan"); await captureScreen("reopened-plan");
        const after = await readScene(), afterLibrary = await get(buildPath()); assert.deepEqual(after, before); assert.deepEqual(afterLibrary.jobs, beforeLibrary.jobs, "Replay changed generation records");
        phaseState.result = { revision: after.revision, definition_sha256: jsonHash(after.definition), artifacts: await downloadAssets(),
          media: await verifySavedPilotMedia({ manifest, page, directory, atomicJson }), generation_submissions: 0 }; await snapshot("replayed");
        const { verifyPilotMotionPlayback } = await import("./quality-pilot-motion-playback.mjs");
        phaseState.result.motion_playback = await verifyPilotMotionPlayback({ page, manifest, navigate, get, directory, atomicJson, log });
        await persist();
        const walkBefore = await readScene(), jobsBefore = (await get(buildPath())).jobs;
        const { verifyPilotWalk } = await import("./quality-pilot-walk.mjs");
        phaseState.result.walk = await verifyPilotWalk({ page, manifest, directory, approvedUiWrites, get, navigate, readScene, log, atomicJson });
        phaseState.result.app_autosaves = phaseState.result.walk.autosaves?.length ?? 0;
        await persist();
        const walkAfter = await readScene(), jobsAfter = (await get(buildPath())).jobs;
        assert.deepEqual(walkAfter.definition, walkBefore.definition, "Final replay walking changed canonical geometry");
        assert.equal(walkAfter.revision, walkBefore.revision); assert.deepEqual(jobsAfter, jobsBefore, "Final replay walking changed generation jobs");
        const networkAfter = await readPilotReplayNetwork({ manifest, get });
        await atomicJson(join(directory, "replay-network-after.json"), networkAfter);
        phaseState.result.network = assertPilotReplayNetworkUnchanged(networkBefore, networkAfter); await persist();
        await snapshot("after-final-walk");
        assert.equal(phaseState.result.walk.status, "passed", "Current furnished interior traversal needs review; preserve all saved media and quality reports");
      } else if (phase === "illustration") {
        assert.ok(manifest.capture_view_id, "Capture and review the saved camera first");
        const { captureCurrentIllustrationSource, illustrationSourceReviewed } = await import("./quality-pilot-capture-source.mjs");
        const source = await captureCurrentIllustrationSource({ manifest, phaseState, get, id, persist, navigate, page, approvedUiWrites, prepareAction, log, atomicJson, directory, captureScreen });
        if (!illustrationSourceReviewed(manifest, source)) {
          phaseState.awaiting_review = "illustration_source"; phaseState.result = { source, submitted: false, accepted: false };
          await persist(); await log("illustration_source_awaiting_review", source);
        } else {
        delete phaseState.awaiting_review;
        const path = `/api/world/${manifest.world.session_id}/views/${source.view_id}/illustrations`, library = await get(path), quote = checkQuote(library.keyframe_capabilities, phaseState.approval.models.keyframe, "Keyframe illustration");
        const prompt = "Warm hand-painted architectural illustration with limestone masonry, teal ceramic roofs and rich wood grain. Keep the saved workshop, all doors, windows, stairs, furnishings, materials and framing exactly. Finish every visible surface and retain the asymmetric neighboring buildings. No text or labels.";
        let generated = await post("keyframe", path, { action: "generate_keyframe", id: await id("illustration"), prompt, confirmed: true, art: false, ...quote }, quote.reservation);
        await waitForJob(path, generated.job.id, false);
        const { runKnownIllustrationRetry } = await import("./quality-pilot-illustration-retry.mjs");
        const retried = await runKnownIllustrationRetry({ manifest, phaseState, library: await get(path), originalId: generated.job.id,
          quote, path, post, id, persist, directory, log });
        if (retried) { generated = retried; await waitForJob(path, generated.job.id, false); }
        const finished = await get(path); await atomicJson(join(directory, "illustration-candidates.json"), finished);
        const assets = finished.assets.filter(asset => asset.id === `illustration_${generated.job.id}`); assert.equal(assets.length, 1);
        for (const asset of assets) { const response = await page.request.get(`/api/world/${manifest.world.session_id}/illustrations/${asset.id}`, { maxRedirects: 0 }); assert.equal(response.status(), 200); const bytes = await response.body(); assert.equal(sha256(bytes), asset.sha256); await writeFile(join(directory, `${asset.id}.${asset.sha256}.${asset.content_type === "image/png" ? "png" : "jpg"}`), bytes, { mode: 0o600 }); }
        const illustrationPanel = page.getByRole("region", { name: "Saved camera views", exact: true }).locator('[aria-label="Camera illustrations"]');
        const showCandidate = async () => {
          await illustrationPanel.getByRole("button", { name: "Refresh illustrations", exact: true }).click();
          await illustrationPanel.getByLabel("Saved illustration", { exact: true }).selectOption(assets[0].id);
          const image = illustrationPanel.getByRole("img", { name: "Generated camera illustration", exact: true });
          await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
          await image.scrollIntoViewIfNeeded();
        };
        await showCandidate();
        phaseState.result = { source, assets, submitted: true, accepted: false }; await persist(); await captureScreen("illustration-awaiting-review"); await log("illustration_needs_owner_review", { asset_ids: assets.map(asset => asset.id) });
        if (assets.some(asset => !asset.keyframe?.passed || asset.keyframe.gate !== "passed" || asset.keyframe.final_image?.sha256 !== asset.sha256)) throw new Error("Illustration did not pass its final-image and camera checks; preserve candidate for owner review");
        const { acceptPilotIllustrationOutput } = await import("./quality-pilot-illustration-output.mjs");
        const selection = await acceptPilotIllustrationOutput({ manifest, phaseState, get, post, persist, log, atomicJson, directory });
        if (selection.accepted) {
          await showCandidate(); await expect(illustrationPanel.getByRole("button", { name: "Accepted illustration", exact: true })).toBeDisabled();
          await captureScreen("illustration-accepted");
        }
        }
      } else if (["edit", "furnishing", "expansion"].includes(phase)) {
        const { runContinuationPhase } = await import("./quality-pilot-continuation.mjs");
        await runContinuationPhase({ phase, manifest, phaseState, get, post, id, persist, navigate, readScene, snapshot, captureScreen, page, button,
          checkQuote: checkTextQuote, checkTextContext, waitForJob, approvedUiWrites, prepareAction, log, atomicJson, directory, ready });
      } else if (phase === "motion") {
        const runMotion = manifest.retries?.motion?.approved === true
          ? (await import("./quality-pilot-motion-retry.mjs")).runKnownMotionRetry
          : (await import("./quality-pilot-motion.mjs")).runMotionPhase;
        await runMotion({ manifest, phaseState, get, post, id, persist, navigate, readScene, snapshot, captureScreen, page, button,
          approvedUiWrites, prepareAction, log, atomicJson, directory, ready });
      }
    }
    assert.deepEqual(errors, [], "Product browser errors occurred");
    phaseState.status = phaseState.awaiting_review ? "awaiting_review" : "complete";
    if (!phaseState.awaiting_review) phaseState.completed_at = new Date().toISOString(); runState.status = phaseState.status;
    await saveOwnership(); await persist(); await log(phaseState.awaiting_review ? "phase_awaiting_review" : "phase_complete", { run });
  } catch (error) {
    if (manifest) { const phaseState = manifest.phases[phase]; if (phaseState) { phaseState.status = "needs_review"; phaseState.error = error.message; } const runState = manifest.runs.find(item => item.id === run); if (runState) runState.status = "needs_review"; await atomicJson(manifestPath, manifest); }
    await log("phase_needs_review", { reason: error.message }); if (page) await page.screenshot({ path: join(directory, `${run}-failure.png`) }).catch(() => {}); throw error;
  } finally {
    if (context) { await context.tracing.stop({ path: join(directory, `${run}-trace.zip`) }).catch(() => {}); await context.close(); }
    if (browser) await browser.close(); await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), environment = args[args.indexOf("--environment") + 1], phase = args[args.indexOf("--phase") + 1];
  if (!args.includes("--environment") || !args.includes("--phase") || !environment || !phase) throw new Error(`Usage: node scripts/run-quality-pilot.mjs --environment <private receipt> --phase ${PHASES.join("|")}`);
  await runPilot({ environment, phase });
}
