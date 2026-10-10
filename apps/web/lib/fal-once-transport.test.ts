// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FalOnceSubmissionUnknownError, submitFalExactlyOnce, type FalOnceInput } from "./fal-once-transport";

const dirs: string[] = [];
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = async (directory: string, file: string) => JSON.parse(await readFile(join(directory, file), "utf8"));
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<FalOnceInput> {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "fal-once-transport-"));dirs.push(evidenceDirectory);
  const body = Buffer.from('{"prompt":"Synthetic fixture only","duration":4,"prompt_expansion_mode":"disabled"}');
  return { evidenceDirectory, body, bodySha256: hash(body), model: "minimax/h3-max/reference-to-video", apiKey: "private-synthetic-test-key" };
}

it("snapshots exact body and durably claims before its one POST; original caller mutations do not alter sent bytes", async () => {
  const input = await fixture(), original = Buffer.from(input.body), originalDirectory = input.evidenceDirectory, originalSha = input.bodySha256;let calls = 0;
  const pending = submitFalExactlyOnce(input, async (url, options) => {
    calls++;expect(String(url)).toBe("https://queue.fal.run/minimax/h3-max/reference-to-video");
    expect(options?.method).toBe("POST");expect(options?.redirect).toBe("error");expect(options?.body).toBe(original.toString());
    expect((options?.headers as Record<string, string>)["X-Fal-No-Retry"]).toBe("1");
    expect(await readFile(join(originalDirectory, "request-original.json"))).toEqual(original);
    const marker = await json(originalDirectory, "submission-started.json");
    expect(marker).toMatchObject({ phase: "submission_started_no_retry", body_sha256: originalSha, timeout_ms: 200000, automatic_retries: 0 });
    return new Response(JSON.stringify({ request_id: "synthetic-native-request-123" }), { status: 200 });
  });
  input.body.fill(0);input.bodySha256 = "0".repeat(64);input.evidenceDirectory = join(originalDirectory, "mutated-path");const ack = await pending;
  expect(calls).toBe(1);expect(ack.request_id).toBe("synthetic-native-request-123");
  expect(ack.body_sha256).toBe(originalSha);expect(ack.evidenceDirectory).toBe(await realpath(originalDirectory));
  const receipt = await json(originalDirectory, "response-receipt.json");expect(receipt).toMatchObject({ complete: true, body_sha256: originalSha });
  expect(hash(await readFile(join(originalDirectory, "response-original.bin")))).toBe(receipt.sha256);
  expect((await stat(join(originalDirectory, "submission-started.json"))).mode & 0o077).toBe(0);
  await expect(stat(input.evidenceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("nested network causes remain private and useful, while thrown errors expose no key/input and a second call cannot retry", async () => {
  const input = await fixture();let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;const cause = Object.assign(new Error(`connect failure Authorization: Key ${input.apiKey} data:image/png;base64,secret-pixels`), { code: "ECONNRESET" });
    throw new TypeError("fetch failed", { cause });
  };
  await expect(submitFalExactlyOnce(input, fetcher)).rejects.toBeInstanceOf(FalOnceSubmissionUnknownError);
  const error = await json(input.evidenceDirectory, "submission-error.json");
  expect(error).toMatchObject({ status: "submission_unknown", phase: "awaiting_http", reservation_retained: true, automatic_retries: 0,
    error: { name: "TypeError", cause: { code: "ECONNRESET" } } });
  expect(JSON.stringify(error)).not.toContain(input.apiKey);expect(JSON.stringify(error)).not.toContain("secret-pixels");
  await expect(submitFalExactlyOnce(input, fetcher)).rejects.toThrow();expect(calls).toBe(1);
});

it("bounded timeout aborts once, preserves uncertainty and never authorizes retry or reservation release", async () => {
  const input = { ...await fixture(), timeoutMs: 1000 };let calls = 0;
  await expect(submitFalExactlyOnce(input, async (_url, options) => {
    calls++;return await new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
  })).rejects.toMatchObject({ status: "submission_unknown", retries: 0, releaseReservation: false });
  expect(calls).toBe(1);
  expect(await json(input.evidenceDirectory, "submission-error.json")).toMatchObject({ aborted: true, error: { name: "TimeoutError" } });
  await expect(submitFalExactlyOnce(input, async () => { calls++;return new Response("{}"); })).rejects.toThrow();expect(calls).toBe(1);
});

it("retains exact large HTTP error bytes and status before parsing/rejecting instead of hiding the original failure", async () => {
  const input = await fixture(), original = JSON.stringify({ detail: [{ msg: "unsupported combination", input: "private-candidate-payload".repeat(20000) }] });let calls = 0;
  await expect(submitFalExactlyOnce(input, async () => { calls++;return new Response(original, { status: 422 }); })).rejects.toBeInstanceOf(FalOnceSubmissionUnknownError);
  expect(calls).toBe(1);expect((await readFile(join(input.evidenceDirectory, "response-original.bin"))).toString()).toBe(original);
  expect(await json(input.evidenceDirectory, "http-response.json")).toMatchObject({ status: 422, ok: false });
  expect(await json(input.evidenceDirectory, "response-receipt.json")).toMatchObject({ complete: true, bytes: Buffer.byteLength(original), sha256: hash(original) });
  const error = await json(input.evidenceDirectory, "submission-error.json");expect(error.http_status).toBe(422);expect(JSON.stringify(error)).not.toContain("private-candidate-payload");
});

it("interrupted response-body reads preserve HTTP headers and exact partial bytes without retry", async () => {
  const input = await fixture(), prefix = Buffer.from('{"request_id":"partially-received');let pulls = 0, calls = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(prefix);
    else controller.error(Object.assign(new Error("response body interrupted"), { code: "UND_ERR_SOCKET" }));
  } }, { highWaterMark: 0 });
  await expect(submitFalExactlyOnce(input, async () => { calls++;return new Response(stream, { status: 200 }); })).rejects.toBeInstanceOf(FalOnceSubmissionUnknownError);
  expect(await json(input.evidenceDirectory, "http-response.json")).toMatchObject({ status: 200, ok: true });
  expect(await readFile(join(input.evidenceDirectory, "response-partial.bin"))).toEqual(prefix);
  expect(await json(input.evidenceDirectory, "response-partial-receipt.json")).toMatchObject({ complete: false, sha256: hash(prefix), bytes: prefix.length });
  expect(await json(input.evidenceDirectory, "submission-error.json")).toMatchObject({ phase: "reading_response", error: { code: "UND_ERR_SOCKET" } });
  await expect(submitFalExactlyOnce(input, async () => { calls++;return new Response("{}"); })).rejects.toThrow();expect(calls).toBe(1);
});

it("simultaneous calls sharing one evidence directory cannot both send", async () => {
  const input = await fixture();let calls = 0;
  const fetcher: typeof fetch = async () => { calls++;return new Response('{"request_id":"synthetic-race-request-123"}'); };
  const results = await Promise.allSettled([submitFalExactlyOnce(input, fetcher), submitFalExactlyOnce(input, fetcher)]);
  expect(calls).toBe(1);expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect((await json(input.evidenceDirectory, "provider-acknowledgment.json")).request_id).toBe("synthetic-race-request-123");
});

it("an unreadable or missing request ID remains unresolved despite HTTP success; exact response evidence survives", async () => {
  for (const raw of ["not-json", '{"status":"accepted"}']) {
    const input = await fixture();let calls = 0;
    await expect(submitFalExactlyOnce(input, async () => { calls++;return new Response(raw); })).rejects.toBeInstanceOf(FalOnceSubmissionUnknownError);
    expect(calls).toBe(1);expect((await readFile(join(input.evidenceDirectory, "response-original.bin"))).toString()).toBe(raw);
    await expect(readFile(join(input.evidenceDirectory, "provider-acknowledgment.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("mismatched bytes, unsafe namespaces, invalid deadlines and conflicting preserved inputs fail before network", async () => {
  const input = await fixture();let calls = 0;const fetcher: typeof fetch = async () => { calls++;return new Response("{}"); };
  for (const changed of [{ ...input, bodySha256: "a".repeat(64) }, { ...input, model: "minimax/../evil" },
    { ...input, model: "https://other.example/model" }, { ...input, timeoutMs: 300001 }, { ...input, timeoutMs: 999 }]) {
    await expect(submitFalExactlyOnce(changed, fetcher)).rejects.toThrow();
  }
  await writeFile(join(input.evidenceDirectory, "request-original.json"), "immutable different original", { mode: 0o600 });
  await expect(submitFalExactlyOnce(input, fetcher)).rejects.toThrow("Existing private input differs");expect(calls).toBe(0);
  await expect(readFile(join(input.evidenceDirectory, "submission-started.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
