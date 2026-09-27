import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const cleanEnv = () => Object.fromEntries(["PATH", "HOME", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));

export function isolateCompose(input, { project, tag, storagePort, webPort, mongoPort, token, password }) {
  const ports = [storagePort, webPort, mongoPort];
  if (!/^ofb-check-[a-f0-9]{12}$/.test(project) || !/^[a-zA-Z0-9_-]+$/.test(tag)
    || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)
    || new Set(ports).size !== ports.length) throw new Error("Invalid isolated check configuration");
  const config = globalThis.structuredClone(input);
  config.name = project;
  for (const [kind, group] of Object.entries({ volumes: config.volumes, networks: config.networks })) for (const value of Object.values(group ?? {})) {
    // Compose normalizes the default network with an empty IPAM object.
    if (kind === "networks" && value.ipam && Object.getPrototypeOf(value.ipam) === Object.prototype && Object.keys(value.ipam).length === 0) delete value.ipam;
    if (Object.keys(value).some(key => key !== "name")) throw new Error("Review custom storage or networks before isolated testing");
    delete value.name;
  }
  const storage = { R2_ENDPOINT: "http://minio:9000", R2_BUCKET: "openflipbook", R2_ACCESS_KEY_ID: "selfhost-check", R2_SECRET_ACCESS_KEY: password,
    R2_PUBLIC_BASE_URL: `http://127.0.0.1:${storagePort}/openflipbook` };
  const common = { ...storage, MONGODB_URI: "mongodb://mongo:27017/?directConnection=true", MONGODB_DB: "selfhost_check", MODAL_API_URL: "http://backend:8787", SHARED_TOKEN: token };
  const environment = {
    mongo: {}, "mongo-init": {},
    minio: { MINIO_ROOT_USER: "selfhost-check", MINIO_ROOT_PASSWORD: password },
    "minio-setup": { MINIO_ROOT_USER: "selfhost-check", MINIO_ROOT_PASSWORD: password, R2_BUCKET: "openflipbook" },
    backend: { MOCK_PROVIDERS: "1", SKETCH_ENABLED: "1", SHARED_TOKEN: token, PORT: "8787", WORLD_MODE: "true", GEOMETRIC_WORLD: "true", SCALE_LADDER_NAV: "true",
      PLACE_BUILD_ENABLED: "0", MESH_GENERATION_ENABLED: "0", MATERIAL_GENERATION_ENABLED: "0", ILLUSTRATION_GENERATION_ENABLED: "0" },
    web: { ...common, NODE_ENV: "production", HOSTNAME: "0.0.0.0", PORT: "3000", WORLD_MODE: "true", GEOMETRIC_WORLD: "true", NEXT_PUBLIC_WORLD_SCENES: "1", NEXT_PUBLIC_SKETCH_ENABLED: "1" },
    "place-worker": common,
  };
  if (Object.keys(config.services).sort().join() !== Object.keys(environment).sort().join()) throw new Error("Review changed Compose services before isolated testing");
  for (const [name, service] of Object.entries(config.services)) {
    if (["network_mode", "pid", "ipc", "privileged", "devices", "secrets", "configs", "volumes_from"].some(key => service[key])) throw new Error("Isolated checks cannot request host access");
    delete service.container_name; delete service.env_file; delete service.profiles; delete service.build;
    service.environment = environment[name]; service.restart = "no";
    service.ports = name === "web" || name === "mongo" || name === "minio" ? [{ target: name === "web" ? 3000 : name === "mongo" ? 27017 : 9000,
      published: String(name === "minio" ? storagePort : name === "web" ? webPort : mongoPort), host_ip: "127.0.0.1", protocol: "tcp" }] : [];
    if (name === "web" || name === "backend" || name === "place-worker") service.image = `openflipbook-selfhost-${name === "place-worker" ? "worker" : name}:${tag}`;
    if ((service.volumes ?? []).some(v => v.type !== "volume" || !Object.hasOwn(config.volumes, v.source))) throw new Error("Isolated checks cannot mount host or external data");
  }
  return config;
}

function run(command, args, { capture = false, cwd = root, env = cleanEnv() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "", error = "";
    child.stdout?.on("data", data => { output += data; }); child.stderr?.on("data", data => { error += data; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} ${args[0]} exited ${code}${capture ? `: ${error.slice(-3000)}` : ""}`)));
  });
}
async function freePort() {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--image-tag" || !/^[a-zA-Z0-9_-]+$/.test(args[1]))) throw new Error("Usage: node scripts/selfhost/check.mjs [--image-tag previously-built-tag]");
  const project = `ofb-check-${randomBytes(6).toString("hex")}`, tag = args[1] ?? project;
  await mkdir(resolve(root, "apps/web/test-results"), { recursive: true });
  const directory = await mkdtemp(resolve(root, "apps/web/test-results/selfhost-"));
  const token = randomBytes(32).toString("hex"), password = randomBytes(24).toString("hex");
  const base = JSON.parse(await run("docker", ["compose", "--env-file", "/dev/null", "--profile", "world-build", "config", "--no-env-resolution", "--format", "json"], { capture: true }));
  const ports = new Set(); while (ports.size < 3) ports.add(await freePort());
  const [storagePort, webPort, mongoPort] = [...ports];
  const config = isolateCompose(base, { project, tag, storagePort, webPort, mongoPort, token, password });
  const file = resolve(directory, "compose.json"); await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  const composeArgs = ["compose", "--env-file", "/dev/null", "--project-name", project, "--project-directory", root, "--file", file];
  const compose = (...args) => run("docker", [...composeArgs, ...args]);
  let started = false;
  try {
    if (!args.length) for (const service of ["backend", "worker", "web"]) await run("docker", ["build", "--progress=plain", "-f", service === "backend" ? "apps/modal-backend/Dockerfile" : "apps/web/Dockerfile",
      ...(service === "worker" ? ["--target", "place-worker"] : service === "web" ? ["--build-arg", "NEXT_PUBLIC_WORLD_SCENES=1", "--build-arg", "NEXT_PUBLIC_SKETCH_ENABLED=1", "--build-arg", "NEXT_PUBLIC_WORLD_MODE=true"] : []), "-t", `openflipbook-selfhost-${service}:${tag}`, "."]);
    started = true; await compose("up", "--detach", "--no-build");
    const port = async (service, target) => await run("docker", [...composeArgs, "port", service, String(target)], { capture: true });
    const origin = `http://${await port("web", 3000)}`, mongo = `mongodb://${await port("mongo", 27017)}/?directConnection=true`;
    const receipt = { project, image_tag: tag, compose_file: file, origin, mongo, database: "selfhost_check", fixture_providers: true, generated_quality_verified: false };
    await writeFile(resolve(directory, "environment.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    process.stdout.write(`Isolated self-host check: ${origin}\nEvidence: ${directory}\n`);
    await run("pnpm", ["exec", "playwright", "test", "e2e/selfhost.spec.ts", "--output", resolve(directory, "browser")], {
      cwd: resolve(root, "apps/web"), env: { ...cleanEnv(), E2E_SELFHOST: "1", E2E_SELFHOST_VIDEO: process.env.E2E_SELFHOST_VIDEO === "1" ? "1" : "0", E2E_BASE_URL: origin, E2E_SELFHOST_RECEIPT: resolve(directory, "environment.json") },
    });
    await writeFile(resolve(directory, "result.json"), JSON.stringify({ ...receipt, passed: true, finished_at: new Date().toISOString() }, null, 2));
  } finally {
    if (started) {
      try { await writeFile(resolve(directory, "services.log"), await run("docker", [...composeArgs, "logs", "--no-color", "--tail", "100"], { capture: true })); }
      finally { await compose("down", "--volumes", "--remove-orphans"); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
