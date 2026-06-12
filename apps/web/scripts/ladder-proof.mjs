/* eslint-disable no-undef */
// Ladder proof harness — drives the REAL app (real clicks, the actual client
// routing/crop logic) through the tap descent ladder across five place types
// and saves every hop's image for independent judgment.
//
//   node scripts/ladder-proof.mjs [runDir]
//   LADDER_ONLY=city,castle node scripts/ladder-proof.mjs
//
// PAID (~$0.55/scenario on the balanced tier). Artifacts per scenario:
//   1_map.jpg              the root map
//   1_region_promised.jpg  the closeup crop window cut from the root map
//   2_closeup.jpg          what the closeup tap actually produced
//   3_enter.jpg            what the transition tap actually produced
//   manifest.json          ids, scene_views, clicks, timings, mechanical checks
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.LADDER_BASE ?? "http://localhost:3000";
const RUN_DIR = path.resolve(
  process.argv[2] ??
    `../../ladder-proof-runs/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
);
const ONLY = process.env.LADDER_ONLY ? process.env.LADDER_ONLY.split(",") : null;

// The seeded frame every top-level map routes through (geo-tap.ts).
const FRAME = { x: 0, y: 0, w: 100, h: 60 };

const SCENARIOS = [
  {
    id: "city",
    target: /palace/i,
    query:
      "A highly detailed 2D top-down fantasy city map of Eshmara, an ancient walled trade city on a great river: distinct districts, a grand Palace with formal gardens on the north bank, a wizards' academy with a tall spire, busy docks, two bridges, city gates — antique hand-inked cartography on aged parchment, fine serif labels",
  },
  {
    id: "castle",
    target: /keep/i,
    query:
      "A detailed top-down map of a lone medieval castle compound on a hill: outer curtain walls with four corner towers, a fortified gatehouse, an inner bailey, the great Keep at the centre, stables, a small chapel, kitchen gardens — hand-inked antique plan style with clear labels",
  },
  {
    id: "harbor",
    target: /lighthouse/i,
    query:
      "A top-down illustrated map of a small coastal harbour town: a stone Lighthouse on the rocky point, two piers with fishing boats, a fish market square, warehouses, a chandlery, the sea wall — weathered nautical chart style with labels",
  },
  {
    id: "forest",
    target: /lodge/i,
    query:
      "A top-down illustrated trail map of a forest national park: a timber Lodge at the heart of the park, a waterfall, a lake with a boathouse, a ranger station, winding trails through pine forest — vintage park-service poster map style with labels",
  },
  {
    id: "scifi",
    target: /command|dome/i,
    query:
      "A top-down schematic map of a small Mars colony: a central Command Dome, a habitat ring, greenhouse modules, a landing pad, a solar farm, a rover garage, connected by tube corridors — retro-futurist blueprint style with clear labels",
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function api(p) {
  try {
    const r = await fetch(`${BASE}${p}`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function saveUrl(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function frameCropToImageBox(crop) {
  const c01 = (v) => Math.min(Math.max(v, 0), 1);
  const x = c01((crop.x - FRAME.x) / FRAME.w);
  const y = c01((crop.y - FRAME.y) / FRAME.h);
  return {
    x,
    y,
    w: Math.min(c01(crop.w / FRAME.w), 1 - x),
    h: Math.min(c01(crop.h / FRAME.h), 1 - y),
  };
}

async function waitStableImage(page, timeoutMs = 300_000, stableMs = 2500) {
  const img = page.locator('img[alt^="Generated illustration"]').first();
  await img.waitFor({ state: "visible", timeout: timeoutMs });
  let last = "";
  let since = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const src = (await img.getAttribute("src")) ?? "";
    if (src && src === last) {
      if (Date.now() - since >= stableMs) return src;
    } else {
      last = src;
      since = Date.now();
    }
    await page.waitForTimeout(300);
  }
  throw new Error("image never stabilised");
}

async function clickAtFraction(page, xf, yf) {
  const img = page.locator('img[alt^="Generated illustration"]').first();
  const box = await img.boundingBox();
  if (!box) throw new Error("no image bounding box");
  await page.mouse.click(box.x + box.width * xf, box.y + box.height * yf);
}

async function cropViaCanvas(page, srcUrl, box) {
  return await page.evaluate(
    async ({ src, b }) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(b.w * img.naturalWidth));
      c.height = Math.max(1, Math.round(b.h * img.naturalHeight));
      const ctx = c.getContext("2d");
      ctx.drawImage(
        img,
        b.x * img.naturalWidth,
        b.y * img.naturalHeight,
        c.width,
        c.height,
        0,
        0,
        c.width,
        c.height,
      );
      return c.toDataURL("image/jpeg", 0.92);
    },
    { src: srcUrl, b: box },
  );
}

async function retriggerExtraction(session, node, caption) {
  // The first post-generation extraction is occasionally empty (the same
  // flake the product's localize-now button covers) — re-trigger it the
  // way the client would.
  try {
    await fetch(`${BASE}/api/world/${encodeURIComponent(session)}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_id: node.id,
        image_data_url: node.image_url,
        caption: caption.slice(0, 1400),
        scene_description: caption.slice(0, 1600),
        scene_view: null,
      }),
    });
  } catch { /* best-effort */ }
}

async function pollTargetEntity(session, matcher, timeoutMs = 240_000, retrigger = null) {
  const deadline = Date.now() + timeoutMs;
  let places = [];
  let retriggered = 0;
  while (Date.now() < deadline) {
    const m = await api(`/api/world/${encodeURIComponent(session)}/map`);
    places = (m?.entities ?? []).filter(
      (e) => e.kind === "place" && (e.parent_id ?? null) === null,
    );
    const hit = places.find((e) => matcher.test(e.label));
    if (hit) return { entity: hit, fallback: false };
    // Two chances to recover from an empty first extraction.
    const elapsed = timeoutMs - (deadline - Date.now());
    if (retrigger && places.length === 0 && elapsed > 60_000 * (retriggered + 1) && retriggered < 2) {
      retriggered += 1;
      log("  (extraction empty — re-triggering, attempt", retriggered + ")");
      await retrigger();
    }
    await sleep(4000);
  }
  if (places.length > 0) {
    // Fallback: the largest-footprint place — the ladder is what's under
    // test, not the extraction's naming.
    const biggest = [...places].sort(
      (a, b) => b.footprint.w * b.footprint.d - a.footprint.w * a.footprint.d,
    )[0];
    return { entity: biggest, fallback: true };
  }
  throw new Error("no place entities ever extracted");
}

async function nodeFromSession(session, nodeId) {
  const s = await api(`/api/sessions/${encodeURIComponent(session)}`);
  return (s?.nodes ?? []).find((n) => n.id === nodeId) ?? null;
}

async function runScenario(browser, scenario) {
  const dir = path.join(RUN_DIR, scenario.id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    scenario: scenario.id,
    query: scenario.query,
    started_at: new Date().toISOString(),
    checks: {},
    errors: [],
  };
  const t0 = Date.now();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  let sessionId = null;
  const persisted = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/generate-page")) {
      try {
        const b = req.postDataJSON();
        if (b?.session_id) sessionId = b.session_id;
        (manifest.generate_bodies ??= []).push({
          mode: b?.mode ?? null,
          render_mode: b?.render_mode ?? null,
          has_scene_view: !!b?.scene_view,
          scene_view_closeup: b?.scene_view?.closeup ?? null,
          world_mode: b?.world_mode ?? null,
          condition_roles: b?.condition_roles ?? null,
        });
      } catch { /* best-effort capture */ }
    }
  });
  page.on("response", async (res) => {
    if (res.url().includes("/api/nodes") && res.request().method() === "POST") {
      try {
        persisted.push(await res.json());
      } catch { /* best-effort capture */ }
    }
  });

  try {
    await page.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
    // World mode MUST be on — fresh contexts seed it from a build-time env
    // var that docker builds don't carry. Click the pill if it's off.
    const worldPill = page.locator('button:has-text("world")').first();
    await worldPill.waitFor({ state: "visible", timeout: 30_000 });
    if ((await worldPill.getAttribute("aria-pressed")) !== "true") {
      await worldPill.click();
      await page.waitForTimeout(300);
    }
    manifest.checks.world_pill_on =
      (await worldPill.getAttribute("aria-pressed")) === "true";
    await page
      .locator('input[placeholder*="Ask about anything"]')
      .fill(scenario.query);
    log(scenario.id, "→ generating root map");
    await page.locator('button:has-text("Go")').first().click();
    await waitStableImage(page);
    const waitNodes = async (count, timeoutMs = 360_000) => {
      const dl = Date.now() + timeoutMs;
      while (persisted.length < count && Date.now() < dl) await sleep(1000);
      if (persisted.length < count) throw new Error(`node ${count} never persisted`);
      return persisted[count - 1];
    };
    const rootNode = await waitNodes(1);
    if (!sessionId) throw new Error("session id never captured");
    manifest.session = sessionId;
    manifest.root = { id: rootNode.id, image_url: rootNode.image_url };
    await saveUrl(rootNode.image_url, path.join(dir, "1_map.jpg"));
    log(scenario.id, "root saved", rootNode.id);

    // ── Hop 1: tap the target place → expect a CLOSEUP ──
    const { entity, fallback } = await pollTargetEntity(
      sessionId,
      scenario.target,
      240_000,
      () => retriggerExtraction(sessionId, rootNode, scenario.query),
    );
    manifest.target = {
      label: entity.label,
      pos: entity.pos,
      footprint: entity.footprint,
      fallback_used: fallback,
    };
    const click1 = { x: entity.pos.x / FRAME.w, y: entity.pos.y / FRAME.h };
    manifest.click1 = click1;
    log(scenario.id, `→ closeup tap on "${entity.label}" @`, click1);
    await clickAtFraction(page, click1.x, click1.y);
    const closeupNode = await waitNodes(2);
    await waitStableImage(page);
    manifest.closeup = { id: closeupNode.id, image_url: closeupNode.image_url };
    await saveUrl(closeupNode.image_url, path.join(dir, "2_closeup.jpg"));

    const closeupDoc = await nodeFromSession(sessionId, closeupNode.id);
    const sv = closeupDoc?.scene_view ?? null;
    manifest.closeup.scene_view = sv;
    manifest.checks.closeup_flag = sv?.closeup === true;
    manifest.checks.closeup_has_crop = !!sv?.map_crop;
    if (sv?.map_crop) {
      const box = frameCropToImageBox(sv.map_crop);
      manifest.closeup.promised_region = box;
      const dataUrl = await cropViaCanvas(page, rootNode.image_url, box);
      fs.writeFileSync(
        path.join(dir, "1_region_promised.jpg"),
        Buffer.from(dataUrl.split(",")[1], "base64"),
      );
    }
    log(scenario.id, "closeup saved", closeupNode.id, "flag:", manifest.checks.closeup_flag);

    // ── Hop 2: tap the same place on its closeup → expect the ENTER ──
    const crop = sv?.map_crop ?? FRAME;
    const clamp = (v) => Math.min(Math.max(v, 0.08), 0.92);
    const click2 = {
      x: clamp((entity.pos.x - crop.x) / crop.w),
      y: clamp((entity.pos.y - crop.y) / crop.h),
    };
    manifest.click2 = click2;
    log(scenario.id, "→ transition tap @", click2);
    await clickAtFraction(page, click2.x, click2.y);
    const enterNode = await waitNodes(3, 480_000);
    await waitStableImage(page, 480_000);
    manifest.enter = { id: enterNode.id, image_url: enterNode.image_url };
    await saveUrl(enterNode.image_url, path.join(dir, "3_enter.jpg"));
    const enterDoc = await nodeFromSession(sessionId, enterNode.id);
    manifest.enter.scene_view = enterDoc?.scene_view ?? null;
    manifest.checks.enter_left_map_register =
      (enterDoc?.scene_view?.level ?? "map") !== "map";
    log(scenario.id, "enter saved", enterNode.id);
  } catch (err) {
    manifest.errors.push(String(err?.message ?? err));
    log(scenario.id, "ERROR:", String(err?.message ?? err));
    try {
      await page.screenshot({ path: path.join(dir, "error_state.png") });
    } catch { /* best-effort capture */ }
  } finally {
    manifest.duration_s = Math.round((Date.now() - t0) / 1000);
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 1),
    );
    await context.close();
  }
  return manifest;
}

const browser = await chromium.launch();
fs.mkdirSync(RUN_DIR, { recursive: true });
log("run dir:", RUN_DIR);
const results = [];
for (const s of SCENARIOS) {
  if (ONLY && !ONLY.includes(s.id)) continue;
  results.push(await runScenario(browser, s));
}
await browser.close();
fs.writeFileSync(
  path.join(RUN_DIR, "run.json"),
  JSON.stringify(
    {
      finished_at: new Date().toISOString(),
      scenarios: results.map((m) => ({
        scenario: m.scenario,
        session: m.session ?? null,
        errors: m.errors,
        checks: m.checks,
        duration_s: m.duration_s,
      })),
    },
    null,
    1,
  ),
);
log("done:", results.length, "scenarios");
