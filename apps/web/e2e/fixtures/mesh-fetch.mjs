import process from "node:process";
import { URL } from "node:url";

// Loaded only by the test-owned worker subprocess. Production downloads still
// enforce HTTPS fal.media; tests substitute one explicitly named fixture URL.
const fetchActual = globalThis.fetch;
const origin = process.env.E2E_MESH_DOWNLOAD_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("Missing loopback mesh fixture origin");
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.href === "https://fal.media/ofb-worker-fixture.glb") return fetchActual(`${origin}/fixture.glb`, init);
  if (url.href === "https://fal.media/ofb-worker-material.jpg") return fetchActual(`${origin}/fixture-material.jpg`, init);
  if (url.hostname === "fal.media" && /^\/ofb-worker-illustration-\d+\.jpg$/.test(url.pathname)) return fetchActual(`${origin}${url.pathname}`, init);
  if (url.hostname !== "127.0.0.1") throw new Error("External worker fetch blocked by test fixture");
  return fetchActual(input, init);
};
