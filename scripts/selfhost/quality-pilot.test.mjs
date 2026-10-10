import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatePilotCompose, quoteHash, readCredentials, validateEnvironment, validateQuote } from "./quality-pilot.mjs";

const quote = () => ({ version: 1, cap_usd: 5, authority: "User approved bounded paid pilot after quote", verified_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
  phases: { layout: { max_reservation: 0.2, models: { layout: { model: "google/test", reservation: 0.2 } } }, replay: { max_reservation: 0, models: {} } },
  backend_env: { LLM_PROVIDER: "openrouter", LLM_TEXT_MODEL: "google/test", PLACE_BUILD_ENABLED: "1", PLACE_BUILD_RESERVATION_USD: 0.2 } });
const options = { project: "ofb-pilot-123456abcdef", tag: "test", storagePort: 21000, webPort: 21001, mongoPort: 21002, token: "fresh-token", password: "fresh-password", credentialsFile: "/private/pilot/providers.env" };
const fixture = () => ({ name: "live", services: Object.fromEntries(["mongo", "mongo-init", "minio", "minio-setup", "backend", "web", "place-worker"].map(name => [name, {
  container_name: `live-${name}`, env_file: [".env"], environment: { FAL_KEY: "live-key", MONGODB_URI: "mongodb://live", SHARED_TOKEN: "live-token" }, build: { context: "." }, volumes: [],
}])), volumes: { "mongo-data": { name: "live_mongo" }, "s3-data": { name: "live_s3" } }, networks: { default: { name: "live_default" } } });
test("preparation isolates every store and disables all approved paid capabilities", () => {
  const source = fixture(), before = structuredClone(source), config = isolatePilotCompose(source, options, quote());
  assert.deepEqual(source, before); assert.doesNotMatch(JSON.stringify(config), /live-key|live-token|mongodb:\/\/live|live_mongo|live_s3|live_default/);
  assert.equal(config.name, options.project); assert.equal(config.services.backend.environment.PLACE_BUILD_ENABLED, "0");
  assert.equal(config.services.backend.environment.MOCK_PROVIDERS, "0"); assert.equal(config.services.web.environment.MONGODB_DB, "quality_pilot");
  assert.equal(config.services.web.environment.MAX_DAILY_SPEND, "5"); assert.equal(config.services["place-worker"].environment.MAX_SESSION_SPEND, "5");
  assert.equal(config.services["place-worker"].stop_grace_period, "360s"); assert.deepEqual(config.services.backend.ports, []);
  assert.deepEqual(config.services.backend.env_file, [{ path: options.credentialsFile, required: true }]);
  for (const name of ["web", "place-worker"]) assert.ok(!config.services[name].env_file);
  assert.equal(config.services.web.ports[0].host_ip, "127.0.0.1"); assert.deepEqual(config.volumes, { "mongo-data": {}, "s3-data": {} });
});
test("explicit start enables only pinned flags and retains disabled alternatives", () => {
  const config = isolatePilotCompose(fixture(), options, quote(), true);
  assert.equal(config.services.backend.environment.PLACE_BUILD_ENABLED, "1"); assert.equal(config.services.backend.environment.MESH_GENERATION_ENABLED, "0");
  assert.equal(config.services.backend.environment.PLACE_BUILD_RESERVATION_USD, "0.2"); assert.equal(config.services.backend.environment.OPENROUTER_ENABLE_WEB_SEARCH, "false");
});
test("rejects shared volumes and host mounts before a pilot starts", () => {
  const source = fixture(); source.services.mongo.volumes = [{ type: "bind", source: "/live/data", target: "/data/db" }];
  assert.throws(() => isolatePilotCompose(source, options, quote()), /host or external data/);
  assert.throws(() => isolatePilotCompose(fixture(), { ...options, project: "openflipbook" }, quote()), /pilot project/);
});
test("retains only explicitly loaded credentials without shell evaluation or store inheritance", () => {
  assert.deepEqual(readCredentials("FAL_KEY='fal-test'\nOPENROUTER_API_KEY=or-test # note\nMONGODB_URI=mongodb://live\nSHARED_TOKEN=old\n"), { FAL_KEY: "fal-test", OPENROUTER_API_KEY: "or-test" });
  assert.throws(() => readCredentials("FAL_KEY=$(cat secret)\nOPENROUTER_API_KEY=or-test"), /unsupported/);
  assert.throws(() => readCredentials("FAL_KEY=fal-test"), /required/);
});
test("rejects expired, unbounded, unapproved and over-cap envelopes", () => {
  const expired = quote(); expired.expires_at = new Date(Date.now() - 500).toISOString(); assert.throws(() => validateQuote(expired), /current explicit/);
  const long = quote(); long.expires_at = new Date(Date.now() + 86400001).toISOString(); assert.throws(() => validateQuote(long), /current explicit/);
  const over = quote(); over.phases.layout.max_reservation = 5.01; assert.throws(() => validateQuote(over), /ceiling/);
  const infinity = quote(); infinity.phases.layout.max_reservation = Infinity; assert.throws(() => validateQuote(infinity), /phase approval/);
  const bad = quote(); bad.backend_env.FAL_KEY = "secret"; assert.throws(() => validateQuote(bad), /environment key/);
  const shared = quote(); shared.backend_env.MONGODB_URI = "mongodb://live"; assert.throws(() => validateQuote(shared), /environment key/);
});
test("rejects altered quote and receipts pointing at unrelated stores or credentials", () => {
  const approved = quote(), receipt = { version: 1, kind: "quality-pilot", project: options.project, evidence_dir: "/private/pilot", compose_file: "/private/pilot/compose.json", credentials_file: "/private/pilot/providers.env", database: "quality_pilot", fixture_providers: false, live_providers: true, cap_usd: 5, quote: approved, quote_sha256: quoteHash(approved), origin: "http://127.0.0.1:21001", mongo: "mongodb://127.0.0.1:21002/?directConnection=true" };
  assert.equal(validateEnvironment(receipt, "/private/pilot/environment.json"), receipt);
  for (const change of [{ mongo: "mongodb://production.test:27017" }, { database: "openflipbook" }, { credentials_file: "/live/.env" }, { origin: "http://127.0.0.1:21001/other" }, { quote_sha256: "old" }, { cap_usd: 10 }]) assert.throws(() => validateEnvironment({ ...receipt, ...change }, "/private/pilot/environment.json"));
});
