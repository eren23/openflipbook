// Real product acceptance uses its own stores and a pinned, bounded approval.
// Importing or preparing this harness never starts services or submits models.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isolateCompose } from "./check.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const phases = new Set(["layout", "appearance", "furnishing", "expansion", "edit", "capture", "illustration", "motion", "replay"]);
const flags = ["PLACE_BUILD_ENABLED", "MATERIAL_GENERATION_ENABLED", "MESH_GENERATION_ENABLED", "MESH_IMAGE_GENERATION_ENABLED", "SCENE_EDIT_ENABLED", "ILLUSTRATION_GENERATION_ENABLED", "ILLUSTRATION_EDIT_GENERATION_ENABLED", "ILLUSTRATION_KEYFRAME_GENERATION_ENABLED", "MOTION_CALIBRATION_ENABLED"];
const backendKeys = new Set([...flags, "LLM_PROVIDER", "LLM_TEXT_MODEL", "LLM_VLM_MODEL", "OPENROUTER_TEXT_MODEL", "OPENROUTER_VLM_MODEL", "LLM_STRUCTURED_OUTPUT", "PLACE_BUILD_RESERVATION_USD", "MATERIAL_RESERVATION_USD", "MESH_RESERVATION_USD", "MESH_IMAGE_RESERVATION_USD", "SCENE_EDIT_RESERVATION_USD", "ILLUSTRATION_RESERVATION_USD", "ILLUSTRATION_EDIT_RESERVATION_USD", "ILLUSTRATION_KEYFRAME_RESERVATION_USD", "MOTION_RESERVATION_USD_PER_SECOND"]);
const cleanEnv = () => Object.fromEntries(["PATH", "HOME", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
export const quoteHash = quote => createHash("sha256").update(JSON.stringify(quote)).digest("hex");

export function validateQuote(quote, now = Date.now()) {
  const checked = Date.parse(quote?.verified_at), expires = Date.parse(quote?.expires_at);
  if (quote?.version !== 1 || typeof quote.authority !== "string" || !quote.authority.trim()
    || !Number.isFinite(quote.cap_usd) || quote.cap_usd <= 0 || quote.cap_usd > 5
    || !Number.isFinite(checked) || !Number.isFinite(expires) || checked > now + 60_000 || checked > expires
    || expires <= now || expires - checked > 24 * 60 * 60_000) throw new Error("A current explicit quote with a ceiling of at most $5 is required");
  if (!quote.phases || !Object.keys(quote.phases).length) throw new Error("Quote has no approved phases");
  let total = 0;
  for (const [name, phase] of Object.entries(quote.phases)) {
    if (!phases.has(name) || !Number.isFinite(phase.max_reservation) || phase.max_reservation < 0 || !phase.models || typeof phase.models !== "object") throw new Error("Invalid phase approval");
    total += phase.max_reservation;
    for (const model of Object.values(phase.models)) if (!model || typeof model.model !== "string" || !model.model.trim() || !Number.isFinite(model.reservation) || model.reservation <= 0 || model.reservation > phase.max_reservation) throw new Error("Invalid approved model reservation");
  }
  if (total > quote.cap_usd + 1e-9) throw new Error("Run-wide phase reservations exceed the approved ceiling");
  if (!quote.backend_env || typeof quote.backend_env !== "object") throw new Error("Quote must pin backend capabilities");
  for (const [key, value] of Object.entries(quote.backend_env)) {
    if (!backendKeys.has(key) || !["string", "number"].includes(typeof value) || /[\r\n\0]/.test(String(value))) throw new Error("Unapproved backend environment key or value");
    if (flags.includes(key) && !["0", "1"].includes(String(value))) throw new Error("Invalid provider enable flag");
    if (key.endsWith("RESERVATION_USD") || key === "MOTION_RESERVATION_USD_PER_SECOND") if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 10) throw new Error("Invalid provider reservation");
  }
  if (quote.backend_env.LLM_PROVIDER !== "openrouter" || !quote.backend_env.LLM_TEXT_MODEL) throw new Error("Pilot must pin the approved OpenRouter text model");
  return quote;
}

export function readCredentials(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(FAL_KEY|OPENROUTER_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^['"]/.test(value)) { if (value.at(-1) !== value[0]) throw new Error("Malformed provider credential"); value = value.slice(1, -1); }
    else value = value.replace(/\s+#.*$/, "").trim();
    if (!value || /[\s\0'"$`\\]/.test(value)) throw new Error("Missing or unsupported provider credential");
    result[match[1]] = value;
  }
  if (!result.FAL_KEY || !result.OPENROUTER_API_KEY) throw new Error("FAL and OpenRouter credentials are required; values are never logged");
  return result;
}

export function isolatePilotCompose(input, options, quote, enabled = false) {
  validateQuote(quote);
  if (!/^ofb-pilot-[a-f0-9]{12}$/.test(options.project)) throw new Error("Invalid isolated pilot project");
  const config = isolateCompose(input, { ...options, project: options.project.replace("ofb-pilot-", "ofb-check-") });
  config.name = options.project;
  const storage = { R2_ENDPOINT: "http://minio:9000", R2_BUCKET: "openflipbook", R2_ACCESS_KEY_ID: "selfhost-check", R2_SECRET_ACCESS_KEY: options.password, R2_PUBLIC_BASE_URL: "/api/blobs" };
  const common = { ...storage, MONGODB_URI: "mongodb://mongo:27017/?directConnection=true", MONGODB_DB: "quality_pilot", MODAL_API_URL: "http://backend:8787", SHARED_TOKEN: options.token,
    MAX_DAILY_SPEND: String(quote.cap_usd), MAX_SESSION_SPEND: String(quote.cap_usd),
    PLACE_BUILD_DAILY_CAP_USD: String(quote.cap_usd), MATERIAL_DAILY_CAP_USD: String(quote.cap_usd), MESH_DAILY_CAP_USD: String(quote.cap_usd), ILLUSTRATION_DAILY_CAP_USD: String(quote.cap_usd), MOTION_DAILY_CAP_USD: String(quote.cap_usd), SCENE_EDIT_DAILY_CAP_USD: String(quote.cap_usd) };
  config.services.web.environment = { ...config.services.web.environment, ...common };
  config.services["place-worker"].environment = common;
  config.services.backend.environment = { SHARED_TOKEN: options.token, PORT: "8787", MOCK_PROVIDERS: "0", SKETCH_ENABLED: "1", WORLD_MODE: "true", GEOMETRIC_WORLD: "true", SCALE_LADDER_NAV: "true",
    OPENROUTER_ENABLE_WEB_SEARCH: "false", WEB_SEARCH_ON_TAP: "false", ANIMATE_PROMPT_REWRITE: "false", WORLD_SEGMENT_BORDERS: "false", RETRY_NO_MEDIA: "false", VIEW_LOOP: "false",
    ...Object.fromEntries(flags.map(flag => [flag, "0"])), ...Object.fromEntries(Object.entries(quote.backend_env).map(([key, value]) => [key, String(value)])) };
  if (!enabled) for (const flag of flags) config.services.backend.environment[flag] = "0";
  if (!options.credentialsFile || !options.credentialsFile.startsWith("/")) throw new Error("Private provider environment file is required");
  config.services.backend.env_file = [{ path: options.credentialsFile, required: true }];
  config.services["place-worker"].stop_grace_period = "360s";
  return config;
}

export function validateEnvironment(receipt, path) {
  const directory = dirname(resolve(path));
  if (receipt?.version !== 1 || receipt.kind !== "quality-pilot" || !/^ofb-pilot-[a-f0-9]{12}$/.test(receipt.project)
    || receipt.evidence_dir !== directory || receipt.compose_file !== resolve(directory, "compose.json") || receipt.credentials_file !== resolve(directory, "providers.env")
    || receipt.database !== "quality_pilot" || receipt.fixture_providers !== false || receipt.live_providers !== true || receipt.cap_usd !== receipt.quote?.cap_usd
    || receipt.quote_sha256 !== quoteHash(receipt.quote)) throw new Error("Invalid private isolated pilot receipt");
  for (const field of ["origin", "mongo"]) {
    const url = new URL(receipt[field]);
    if (url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || (field === "origin" ? url.protocol !== "http:" || url.pathname !== "/" : url.protocol !== "mongodb:")) throw new Error("Pilot stores and browser must use explicit loopback ports");
  }
  return receipt;
}
async function json(path, value) { await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(`${path}.tmp`, path); await chmod(path, 0o600); }
function run(command, args, { capture = false, cwd = root, env = cleanEnv() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = ""; child.stdout?.on("data", data => { output += data; });
    // Raw service errors may include provider requests. Persist logs separately,
    // and keep CLI failures free of credentials and request contents.
    child.stderr?.resume(); child.once("error", reject); child.once("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} ${args[0]} failed (${code}); stores and evidence are preserved`)));
  });
}
async function freePort() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const server = createServer(), port = randomInt(20000, 49152);
    try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); await new Promise(resolve => server.close(resolve)); return port; }
    catch (error) { if (!["EADDRINUSE", "EADDRNOTAVAIL"].includes(error.code)) throw error; }
  }
  throw new Error("No free isolated loopback port available");
}
const composeArgs = receipt => ["compose", "--env-file", "/dev/null", "--project-name", receipt.project, "--project-directory", root, "--file", receipt.compose_file];
async function load(path) {
  if (!path) throw new Error("--environment must identify a private pilot receipt");
  const file = resolve(path), info = await lstat(file);
  if (!info.isFile() || info.mode & 0o077) throw new Error("Pilot receipt must be a private regular file (0600)");
  const receipt = validateEnvironment(JSON.parse(await readFile(file, "utf8")), file);
  for (const privateFile of [receipt.compose_file, receipt.credentials_file]) {
    const privateInfo = await lstat(privateFile);
    if (!privateInfo.isFile() || privateInfo.mode & 0o077) throw new Error("Pilot configuration must be private regular files");
  }
  if (receipt.compose_sha256 !== quoteHash(JSON.parse(await readFile(receipt.compose_file, "utf8")))) throw new Error("Prepared pilot configuration changed; reconcile before starting or stopping services");
  return receipt;
}
async function logServices(receipt) {
  let text = await run("docker", [...composeArgs(receipt), "logs", "--no-color", "--tail", "250"], { capture: true }).catch(() => "Service logs unavailable");
  const credentials = readCredentials(await readFile(receipt.credentials_file, "utf8"));
  const config = JSON.parse(await readFile(receipt.compose_file, "utf8"));
  for (const secret of [...Object.values(credentials), config.services.backend.environment.SHARED_TOKEN, config.services.minio.environment.RUSTFS_SECRET_KEY]) if (secret) text = text.split(secret).join("[redacted]");
  await writeFile(resolve(receipt.evidence_dir, "services.log"), text, { mode: 0o600 });
}
async function stop(receipt, path, failure = false) {
  await run("docker", [...composeArgs(receipt), "stop", "--timeout", "360", "place-worker"]);
  await logServices(receipt);
  await run("docker", [...composeArgs(receipt), "stop", "web", "backend", "mongo", "minio"]);
  receipt.state = failure ? "failed_stopped" : "stopped"; receipt.stopped_at = new Date().toISOString();
  await json(resolve(path), receipt);
}
async function prepare(values) {
  if (!values.quote) throw new Error("prepare requires --quote with the explicit bounded approval");
  const quote = validateQuote(JSON.parse(await readFile(resolve(values.quote), "utf8"))), tag = values["image-tag"] ?? "ofb-check-b6844ccb485e";
  if (!/^[a-zA-Z0-9_-]+$/.test(tag)) throw new Error("Invalid image tag");
  const credentials = readCredentials(await readFile(resolve(values.credentials ?? "apps/modal-backend/.env"), "utf8"));
  const imageIds = {};
  for (const kind of ["backend", "worker", "web"]) imageIds[kind] = await run("docker", ["image", "inspect", "--format", "{{.Id}}", `openflipbook-selfhost-${kind}:${tag}`], { capture: true });
  const base = JSON.parse(await run("docker", ["compose", "--env-file", "/dev/null", "--profile", "world-build", "config", "--no-env-resolution", "--format", "json"], { capture: true }));
  await mkdir(resolve(root, "apps/web/test-results"), { recursive: true });
  const directory = await mkdtemp(resolve(root, "apps/web/test-results/quality-pilot-")); await chmod(directory, 0o700);
  const credentialsFile = resolve(directory, "providers.env"); await writeFile(credentialsFile, Object.entries(credentials).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
  const ports = new Set(); while (ports.size < 3) ports.add(await freePort()); const [storagePort, webPort, mongoPort] = [...ports];
  const options = { project: `ofb-pilot-${randomBytes(6).toString("hex")}`, tag, storagePort, webPort, mongoPort, credentialsFile, token: randomBytes(32).toString("hex"), password: randomBytes(24).toString("hex") };
  const config = isolatePilotCompose(base, options, quote, false), file = resolve(directory, "compose.json"); await json(file, config);
  const receipt = { version: 1, kind: "quality-pilot", project: options.project, image_tag: tag, image_ids: imageIds, compose_file: file, evidence_dir: directory,
    credentials_file: credentialsFile, compose_sha256: quoteHash(config), origin: `http://127.0.0.1:${webPort}`, mongo: `mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, database: "quality_pilot",
    fixture_providers: false, live_providers: true, state: "prepared", cap_usd: quote.cap_usd, approved_phases: Object.keys(quote.phases), quote, quote_sha256: quoteHash(quote), created_at: new Date().toISOString() };
  await json(resolve(directory, "environment.json"), receipt);
  process.stdout.write(`Prepared with providers disabled. No model calls or stores started.\nEnvironment: ${resolve(directory, "environment.json")}\nQuote SHA256: ${receipt.quote_sha256}\n`);
}
async function start(receipt, path, values) {
  validateQuote(receipt.quote);
  if (values["allow-run"] !== receipt.quote_sha256 || receipt.state !== "prepared") throw new Error("Starting requires the exact --allow-run quote hash and a fresh prepared run; unresolved runs cannot restart automatically");
  for (const [kind, id] of Object.entries(receipt.image_ids)) if (await run("docker", ["image", "inspect", "--format", "{{.Id}}", `openflipbook-selfhost-${kind}:${receipt.image_tag}`], { capture: true }) !== id) throw new Error("Prepared application image changed");
  const scope = `label=com.docker.compose.project=${receipt.project}`;
  const existingContainers = await run("docker", ["ps", "--all", "--quiet", "--filter", scope], { capture: true });
  const existingVolumes = await run("docker", ["volume", "ls", "--quiet", "--filter", scope], { capture: true });
  if (existingContainers || existingVolumes) throw new Error("Fresh paid pilots cannot reuse existing containers or store volumes; reconcile the retained run instead");
  const config = JSON.parse(await readFile(receipt.compose_file, "utf8"));
  for (const [key, value] of Object.entries(receipt.quote.backend_env)) config.services.backend.environment[key] = String(value);
  await json(receipt.compose_file, config); receipt.compose_sha256 = quoteHash(config); receipt.state = "starting"; await json(resolve(path), receipt);
  try {
    await run("docker", [...composeArgs(receipt), "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120"]);
    receipt.state = "running"; receipt.started_at = new Date().toISOString(); await json(resolve(path), receipt);
    process.stdout.write(`Isolated paid pilot ready: ${receipt.origin}\nEvidence retained: ${receipt.evidence_dir}\n`);
  } catch (error) { await stop(receipt, path, true).catch(() => {}); throw error; }
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { quote: { type: "string" }, credentials: { type: "string" }, "image-tag": { type: "string" }, environment: { type: "string" }, "allow-run": { type: "string" }, phase: { type: "string" }, help: { type: "boolean" } } });
  const command = positionals[0];
  if (values.help || command === "help") { process.stdout.write("quality-pilot.mjs prepare --quote approval.json [--credentials backend.env] [--image-tag tag]\nquality-pilot.mjs start --environment environment.json --allow-run <quote-sha256>\nquality-pilot.mjs run --environment environment.json --phase layout|appearance|furnishing|expansion|edit|capture|illustration|motion|replay --allow-run <quote-sha256>\nquality-pilot.mjs stop --environment environment.json\nPreparation is free. Each phase retains evidence; failures stop services. Volumes are retained for existing operator-backup export and recovery.\n"); return; }
  if (command === "prepare") return prepare(values);
  const receipt = await load(values.environment);
  if (!["start", "stop", "run"].includes(command)) throw new Error("Unknown pilot command");
  // Driver owns a second durable lock and run-wide envelope. This lifecycle
  // lock prevents concurrent stop/start/phase actions through this harness.
  const lock = await open(resolve(receipt.evidence_dir, "harness.lock"), "wx", 0o600).catch(() => { throw new Error("Pilot harness is already running; reconcile its lock before another execution"); });
  try {
    if (command === "start") return await start(receipt, values.environment, values);
    if (command === "stop") return await stop(receipt, values.environment);
    if (!receipt.approved_phases.includes(values.phase) || receipt.state !== "running" || values["allow-run"] !== receipt.quote_sha256) throw new Error("Invalid run phase or explicit quote gate");
    validateQuote(receipt.quote);
    try { await run("node", [resolve(root, "apps/web/scripts/run-quality-pilot.mjs"), "--environment", resolve(values.environment), "--phase", values.phase], { cwd: resolve(root, "apps/web") }); }
    catch (error) { await stop(receipt, values.environment, true).catch(() => {}); throw error; }
  } finally { await lock.close(); await unlink(resolve(receipt.evidence_dir, "harness.lock")); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
