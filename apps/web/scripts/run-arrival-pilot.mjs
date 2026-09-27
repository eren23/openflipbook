// Explicitly approved live trial. Source seeding only; all metadata is extracted.
import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { MongoClient } from "mongodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { chromium } from "@playwright/test";

if (process.env.ARRIVAL_PILOT !== "1") throw new Error("ARRIVAL_PILOT=1 required");
const BASE = "http://127.0.0.1:3003", BACKEND = "http://127.0.0.1:8001";
const out = resolve("../modal-backend/tests/continuity_bench/reports/arrival-audit");
const report = JSON.parse(await readFile(`${out}/manifest.json`, "utf8"));
const { token } = JSON.parse(await readFile(`${out}/control.json`, "utf8"));
const client = new MongoClient("mongodb://127.0.0.1:27017/?directConnection=true");
const s3 = new S3Client({ region: "auto", endpoint: "http://127.0.0.1:9000", forcePathStyle: true, credentials: { accessKeyId: "openflipbook", secretAccessKey: "openflipbook-local" } });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const scrub = value => typeof value === "string" && value.startsWith("data:") ? { data_url_sha256: hash(value) }
  : Array.isArray(value) ? value.map(scrub)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)])) : value;
async function json(path, value) { await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2)); await rename(`${path}.tmp`, path); }
async function read(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; return null; } }
async function activate(operation) {
  const r = await fetch(`${BACKEND}/pilot/activate`, { method: "POST", headers: { "content-type": "application/json", "x-pilot-token": token }, body: JSON.stringify({ operation }) });
  if (!r.ok) throw new Error(`Activation failed ${r.status}`);
}
async function save() {
  const meter = await (await fetch(`${BACKEND}/pilot/status`)).json();
  Object.assign(report, meter, { status: "live_pilot" });
  await json(`${out}/manifest.json`, report);
}
await client.connect();
const db = client.db("openflipbook_healthcheck");
const browser = await chromium.launch({ headless: true });
try {
  for (const c of report.cases) {
    if (process.env.ARRIVAL_CASE && process.env.ARRIVAL_CASE !== c.id) continue;
    const source = await readFile(resolve("../modal-backend/tests/click_bench/fixtures/images/real", c.source));
    if (hash(source) !== c.source_sha256) throw new Error("Source changed");
    const setupPath = `${out}/${c.id}-automatic.json`;
    let setup = await read(setupPath);
    if (!setup) {
      const session = `arrival-live-${c.id}-bootstrap`, node = `${session}-root`, owner = randomUUID();
      if (await db.collection("nodes").findOne({ _id: node })) throw new Error("Unrecorded bootstrap exists; reconcile before retry");
      const key = `${session}/source.jpg`;
      await s3.send(new PutObjectCommand({ Bucket: "openflipbook", Key: key, Body: source, ContentType: "image/jpeg" }));
      const root = { _id: node, session_id: session, parent_id: null, page_title: c.source.replace(".jpg", ""), query: c.source.replace(".jpg", ""), image_key: key, image_model: "user-upload", prompt_author_model: "user-upload", aspect_ratio: "16:9", sources: [], relation: "descend", created_at: new Date(), geo_extracted: true, scene_view: null };
      await db.collection("nodes").insertOne(root);
      await db.collection("session_owners").insertOne({ _id: session, owner_token: owner });
      await activate(`${c.id}-extract`);
      setup = { state: "submitted", session, node, source_sha256: hash(source) };
      await json(setupPath, setup);
      const r = await fetch(`${BASE}/api/world/${session}/extract`, { method: "POST", headers: { "content-type": "application/json", cookie: `ofb_owner=${owner}` }, body: JSON.stringify({ node_id: node, image_data_url: `data:image/jpeg;base64,${source.toString("base64")}`, caption: root.page_title }) });
      setup.response = await r.json();
      setup.http_status = r.status;
      setup.root = await db.collection("nodes").findOne({ _id: node });
      setup.world = await db.collection("world_state").findOne({ _id: session });
      setup.map = await db.collection("world_map").findOne({ _id: session });
      setup.state = r.ok && setup.map?.entities?.length ? "complete" : "failed";
      await json(setupPath, setup); await save();
      console.log(JSON.stringify({ case: c.id, extraction: setup.state, entities: setup.map?.entities?.length }));
    }
    if (setup.state !== "complete") { console.log(`Extraction unavailable for ${c.id}; no image submissions`); continue; }
    const frozenMap = await db.collection("world_map").findOne({ _id: setup.session });
    const frozenWorld = await db.collection("world_state").findOne({ _id: setup.session });
    if (JSON.stringify(frozenMap) !== JSON.stringify(setup.map) || JSON.stringify(frozenWorld) !== JSON.stringify(setup.world)) throw new Error("Automatic metadata changed after extraction");
    for (const cell of report.cells.filter(cell => cell.case_id === c.id)) {
      const setupRetry = process.env.ARRIVAL_RETRY_SETUP === "1" && cell.state === "failed";
      if (cell.state !== "not_submitted" && !setupRetry) continue;
      if (setupRetry) {
        const ledger = await read(`${out}/ledger.json`);
        if (await read(`${out}/${cell.id}-request.json`) || Object.values(ledger.cells).some(call => call.operation === cell.id)) throw new Error("Cannot retry a started paid trial");
        await json(`${out}/${cell.id}-setup-failure.json`, cell);
      }
      const session = `arrival-live-${cell.id}`, node = `${session}-root`, owner = randomUUID();
      if (!setupRetry && await db.collection("nodes").findOne({ _id: node })) throw new Error("Unrecorded trial exists; reconcile before retry");
      // Clone only the automatic root metadata. Never carry generated arrivals between trials.
      const ids = { [setup.node]: node, [setup.session]: session };
      const remap = value => value instanceof Date ? new Date(value) : typeof value === "string" ? ids[value] ?? value
        : Array.isArray(value) ? value.map(remap)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [ids[key] ?? key, remap(item)])) : value;
      const root = remap(setup.root); root._id = node; root.session_id = session;
      // Keep the immutable original upload key, not a nonexistent remapped key.
      root.image_key = setup.root.image_key; root.created_at = new Date(); root.geo_extracted = true;
      await db.collection("nodes").replaceOne({ _id: node }, root, { upsert: true });
      await db.collection("session_owners").replaceOne({ _id: session }, { _id: session, owner_token: owner }, { upsert: true });
      for (const [collection, data] of [["world_map", frozenMap], ["world_state", frozenWorld]]) if (data) await db.collection(collection).replaceOne({ _id: session }, remap(data), { upsert: true });
      await activate(cell.id);
      Object.assign(cell, { state: "submitted", error: null, session_id: session, root_node_id: node, started_at: new Date().toISOString() }); await save();
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addCookies([{ name: "ofb_owner", value: owner, url: BASE, httpOnly: true }]);
      await context.route(/\/api\/(animate|ltx|precompute)|\/api\/world\/[^/]+\/(extract|plan-world)/, route => route.fulfill({ status: 403, json: { error: "No background paid work in the pilot" } }));
      const page = await context.newPage();
      let resolveFinal;
      const final = new Promise(resolve => { resolveFinal = resolve; });
      let submitted = false;
      await page.route("**/api/generate-page", async route => {
        if (submitted) { await route.abort(); return; }
        submitted = true;
        try {
          const body = { ...route.request().postDataJSON(), max_attempts: 1, image_model: report.model };
          await json(`${out}/${cell.id}-browser-request.json`, scrub(body));
          if (!body.strict_world || body.arrival_intent !== "exterior") throw new Error("Click did not request a strict exterior");
          const response = await route.fetch({ postData: JSON.stringify(body), timeout: 600_000, maxRetries: 0 });
          const text = await response.text();
          await writeFile(`${out}/${cell.id}-events.txt`, text);
          const events = text.split("\n").filter(line => line.startsWith("data:")).flatMap(line => { try { return [JSON.parse(line.slice(5))]; } catch { return []; } });
          const event = events.findLast(e => ["final", "error"].includes(e.type));
          const data = event?.image_data_url ?? event?.candidate_image_data_url;
          Object.assign(cell, { state: data ? "complete" : "failed", view_verdict: event?.view_verdict ?? null, arrival: event?.view_verdict?.arrival ?? null, error: event?.type === "error" ? event.message : !event ? text.slice(0, 500) : null,
            completed_at: new Date().toISOString(), parser_sha256: hash(await readFile(resolve("../modal-backend/providers/arrival.py"))) });
          if (data) {
            const pixels = Buffer.from(data.split(",")[1], "base64");
            await writeFile(`${out}/${cell.id}-candidate.png`, pixels);
            cell.output_sha256 = hash(pixels);
          }
          const resolved = await read(`${out}/${cell.id}-request.json`);
          if (resolved?.place_reference) {
            const ref = resolved.place_reference;
            c.runtime_reference = { bbox: [ref.bbox.x_pct, ref.bbox.y_pct, ref.bbox.w_pct, ref.bbox.h_pct], provenance: ref.provenance.kind, source_sha256: ref.provenance.image_sha256 };
            cell.runtime_reference = ref;
          }
          await json(`${out}/${cell.id}-receipt.json`, cell); await save();
          await route.fulfill({ response, body: text });
          resolveFinal(true);
        } catch (e) { cell.state = "failed"; cell.error = String(e); await json(`${out}/${cell.id}-receipt.json`, cell); await save(); await route.abort(); resolveFinal(false); }
      });
      try {
        await page.goto(`${BASE}/play?continue=${session}&node=${node}`);
        const image = page.getByRole("img", { name: `Generated illustration for ${root.query}`, exact: true });
        await image.waitFor({ state: "visible", timeout: 30_000 });
        await page.getByRole("button", { name: "Inspect places", exact: true }).click();
        await page.getByRole("dialog", { name: "Place inspector", exact: true }).waitFor({ timeout: 30_000 });
        await page.getByRole("navigation", { name: "Places", exact: true }).getByRole("button").first().waitFor({ state: "visible", timeout: 30_000 });
        await page.getByRole("button", { name: "Close place inspector" }).click();
        const box = await image.boundingBox();
        await image.click({ position: { x: box.width * c.click.x_pct, y: box.height * c.click.y_pct }, timeout: 10_000 });
        // An ambiguous chooser is evidence, not permission to silently pick a target.
        await Promise.race([final, page.getByRole("dialog", { name: "Choose a place" }).waitFor({ timeout: 610_000 }).then(() => { throw new Error("Ambiguous target: chooser requires a user decision"); })]);
        await page.screenshot({ path: `${out}/${cell.id}-browser.png`, fullPage: true });
      } catch (e) { if (cell.state === "submitted") { cell.state = "failed"; cell.error = String(e); await json(`${out}/${cell.id}-receipt.json`, cell); await save(); } }
      finally { await context.close(); }
      console.log(JSON.stringify({ trial: cell.id, state: cell.state, accepted: cell.view_verdict?.accepted, arrival: cell.arrival, error: cell.error }));
      if (process.env.ARRIVAL_ONE === "1") break;
    }
  }
  await save();
} finally { await browser.close(); await client.close(); s3.destroy(); }
