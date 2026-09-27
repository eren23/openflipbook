import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateCompose } from "./check.mjs";

const options = { project: "ofb-check-123456abcdef", tag: "test", storagePort: 19000, webPort: 19001, mongoPort: 19002, token: "test-token", password: "test-password" };
const fixture = () => ({ name: "live", services: Object.fromEntries(["mongo", "mongo-init", "minio", "minio-setup", "backend", "web", "place-worker"].map(name => [name, {
  container_name: `live-${name}`, env_file: [".env", "apps/web/.env.local"], environment: { FAL_KEY: "do-not-copy", MONGODB_URI: "mongodb://live", SHARED_TOKEN: "live-token" },
  ports: [{ target: 3000, published: "3000" }], build: { context: "." }, profiles: ["world-build"], volumes: [],
}])), volumes: { "mongo-data": { name: "live_mongo" }, "minio-data": { name: "live_minio" } }, networks: { default: { name: "live_default" } } });

test("isolates stores, credentials and ports without mutating the source Compose configuration", () => {
  const original = fixture(), before = globalThis.structuredClone(original), isolated = isolateCompose(original, options);
  assert.deepEqual(original, before); assert.doesNotMatch(JSON.stringify(isolated), /do-not-copy|live-token|mongodb:\/\/live|live_mongo|live_default|\.env/);
  assert.equal(isolated.services.backend.environment.MOCK_PROVIDERS, "1");
  assert.equal(isolated.services.backend.environment.SKETCH_ENABLED, "1");
  assert.equal(isolated.services.web.environment.NEXT_PUBLIC_SKETCH_ENABLED, "1");
  assert.equal(isolated.services.backend.environment.PLACE_BUILD_ENABLED, "0");
  assert.equal(isolated.services.backend.environment.SHARED_TOKEN, options.token);
  assert.equal(isolated.services.web.environment.MONGODB_DB, "selfhost_check");
  assert.equal(isolated.services.web.environment.R2_PUBLIC_BASE_URL, "http://127.0.0.1:19000/openflipbook");
  assert.deepEqual(isolated.services.web.ports, [{ target: 3000, published: "19001", host_ip: "127.0.0.1", protocol: "tcp" }]);
  assert.deepEqual(isolated.services.mongo.ports, [{ target: 27017, published: "19002", host_ip: "127.0.0.1", protocol: "tcp" }]);
  assert.deepEqual(isolated.services.backend.ports, []); assert.equal(isolated.services.web.image, "openflipbook-selfhost-web:test");
  for (const service of Object.values(isolated.services)) { assert.ok(!("env_file" in service)); assert.ok(!("container_name" in service)); }
});
test("refuses unreviewed services or host data mounts", () => {
  const extra = fixture(); extra.services.extra = extra.services.web;
  assert.throws(() => isolateCompose(extra, options), /changed Compose services/);
  const bind = fixture(); bind.services.mongo.volumes = [{ type: "bind", source: "/live-data", target: "/data/db" }];
  assert.throws(() => isolateCompose(bind, options), /host or external data/);
});
test("refuses external volume drivers and privileged host access", () => {
  const volume = fixture(); volume.volumes["mongo-data"].driver_opts = { device: "/live-data" };
  assert.throws(() => isolateCompose(volume, options), /custom storage or networks/);
  const network = fixture(); network.services.web.network_mode = "host";
  assert.throws(() => isolateCompose(network, options), /host access/);
});
test("accepts Compose's empty default IPAM but rejects custom network ranges", () => {
  const config = fixture(); config.networks.default.ipam = {};
  assert.deepEqual(isolateCompose(config, options).networks, { default: {} });
  assert.deepEqual(config.networks.default.ipam, {});
  config.networks.default.ipam = { config: [{ subnet: "172.20.0.0/16" }] };
  assert.throws(() => isolateCompose(config, options), /custom storage or networks/);
});
for (const change of [{ project: "openflipbook" }, { tag: "bad:tag" }, { storagePort: 3000.5 }, { storagePort: 80 }, { webPort: 0 }, { mongoPort: 65536 }, { webPort: options.storagePort }]) test(`rejects unsafe isolation parameters ${JSON.stringify(change)}`, () => {
  assert.throws(() => isolateCompose(fixture(), { ...options, ...change }), /Invalid isolated check/);
});
