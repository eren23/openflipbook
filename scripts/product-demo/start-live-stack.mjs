// Local, persistent demo installation. No scene seeding or provider submission.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const [tag] = process.argv.slice(2);
if (!tag || !/^ofb-check-[a-f0-9]{12}$/.test(tag) || process.argv.length !== 3) throw new Error("Pass the verified production image tag");
const name = "ofb-live-demo-20260914", shared = randomBytes(32).toString("hex");
const web = parseEnv(readFileSync(resolve(root, "apps/web/.env.local"), "utf8"));
const backend = parseEnv(readFileSync(resolve(root, "apps/modal-backend/.env"), "utf8"));
const run = args => {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
for (const part of ["backend", "web", "worker"]) {
  const check = spawnSync("docker", ["container", "inspect", `${name}-${part}`], { stdio: "ignore" });
  if (check.status === 0) throw new Error(`Existing ${name}-${part}: inspect it; do not overwrite or restart blindly`);
}
run(["network", "create", name]);
const common = { ...web, SHARED_TOKEN: shared, MONGODB_URI: "mongodb://host.docker.internal:27017/?directConnection=true", MONGODB_DB: "ofb_live_demo_20260914",
  MODAL_API_URL: `http://${name}-backend:8787`, MAX_DAILY_SPEND: "3.50", MAX_SESSION_SPEND: "3.50", PLACE_BUILD_DAILY_CAP_USD: "0.90",
  MESH_DAILY_CAP_USD: "1.50", MATERIAL_DAILY_CAP_USD: "0.50", ILLUSTRATION_DAILY_CAP_USD: "0.30", NODE_ENV: "production" };
const settings = {
  backend: { ...backend, SHARED_TOKEN: shared, PORT: "8787", MOCK_PROVIDERS: "0", SKETCH_ENABLED: "1", WORLD_MODE: "true", GEOMETRIC_WORLD: "true", SCALE_LADDER_NAV: "true",
    PLACE_BUILD_ENABLED: "1", PLACE_BUILD_RESERVATION_USD: "0.30", MESH_GENERATION_ENABLED: "1", MESH_RESERVATION_USD: "0.75",
    MESH_IMAGE_GENERATION_ENABLED: "0", MATERIAL_GENERATION_ENABLED: "1", MATERIAL_RESERVATION_USD: "0.0675",
    ILLUSTRATION_GENERATION_ENABLED: "1", ILLUSTRATION_RESERVATION_USD: "0.08", ILLUSTRATION_REGION_GENERATION_ENABLED: "0",
    OPENROUTER_ENABLE_WEB_SEARCH: "false", LLM_TEXT_MODEL: "google/gemini-3.7-flash", LLM_VLM_MODEL: "google/gemini-3.7-flash", MAX_DAILY_SPEND: "1", MAX_SESSION_SPEND: "1" },
  worker: common,
  web: { ...common, HOSTNAME: "0.0.0.0", PORT: "3000", NEXT_PUBLIC_WORLD_SCENES: "1", NEXT_PUBLIC_SKETCH_ENABLED: "1" },
};
for (const part of ["backend", "worker", "web"]) {
  const env = Object.fromEntries(Object.entries(settings[part]).filter(([key]) => /^[A-Z_0-9]+$/.test(key)));
  const result = spawnSync("docker", ["run", "--detach", "--name", `${name}-${part}`, "--network", name,
    ...(part === "web" ? ["--publish", "127.0.0.1:3004:3000"] : part === "backend" ? ["--publish", "127.0.0.1:8788:8787"] : []),
    ...Object.keys(env).flatMap(key => ["--env", key]), `openflipbook-selfhost-${part}:${tag}`], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not start ${part}; inspect the named demo containers before retrying`);
}
console.log(JSON.stringify({ origin: "http://127.0.0.1:3004", database: common.MONGODB_DB, containers: Object.keys(settings).map(p => `${name}-${p}`), image_tag: tag,
  prepared_scene_assets: false, provider_calls_on_start: 0, approved_total_usd: 4, note: "Reservations are not provider invoice limits. Inspect actual jobs and costs before each new submission." }, null, 2));
