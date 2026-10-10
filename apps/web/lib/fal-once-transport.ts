import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

/** Transport only: callers still own quotes, owner/source fences and reservations. */
export interface FalOnceInput {
  model: string;
  body: Buffer;
  bodySha256: string;
  apiKey: string;
  evidenceDirectory: string;
  /** Total fetch/body-read limit; explicitly bounded, never a retry interval. */
  timeoutMs?: number;
}
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const MAX_BYTES = 32 * 1024 * 1024;
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function writeNew(path: string, bytes: Buffer) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function preserveExact(path: string, bytes: Buffer) {
  try { await writeNew(path, bytes); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    requireCondition((await readFile(path)).equals(bytes), "Existing private input differs; preserve it and stop");
  }
}

/** Retain useful nested Undici/abort causes without exporting credentials or input payloads. */
function errorEvidence(error: unknown, key: string, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== "object" || depth >= 4) return { name: "UnknownError" };
  const value = error as { name?: unknown; message?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
  const token = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : undefined;
  const original = typeof value.message === "string" ? value.message : "";
  const message = original.length > 2048 ? "[Long message withheld; exact digest retained]" : original
    .split(key).join("[API key redacted]")
    .replace(/data:[^\s"']+/g, "[Data URI redacted]")
    .replace(/(Authorization\s*[:=]\s*|\bKey\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s"']+/g, "[URL redacted]");
  return { name: token(value.name) ?? "Error", code: token(value.code),
    errno: typeof value.errno === "number" && Number.isFinite(value.errno) ? value.errno : undefined,
    message, message_sha256: sha(original), ...(value.cause ? { cause: errorEvidence(value.cause, key, depth + 1) } : {}) };
}

export class FalOnceSubmissionUnknownError extends Error {
  readonly status = "submission_unknown";
  readonly retries = 0;
  readonly releaseReservation = false;
  constructor(readonly bodySha256: string, readonly evidenceDirectory: string) {
    super("Fal submission unresolved; inspect private evidence and recover GET only. Never resubmit or release automatically.");
    this.name = "FalOnceSubmissionUnknownError";
  }
}

/** One paid fetch maximum per evidence directory. No uploads, polling or budget writes. */
export async function submitFalExactlyOnce(input: FalOnceInput, fetcher: typeof fetch = fetch) {
  // Snapshot bytes before the first await; no caller mutation can change what is sent.
  const body = Buffer.from(input.body), model = input.model, key = input.apiKey;
  const bodySha256 = input.bodySha256, evidenceDirectory = input.evidenceDirectory;
  const timeoutMs = input.timeoutMs ?? 200_000;
  requireCondition(typeof model === "string" && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(model)
    && !model.split("/").some(part => part === "." || part === ".."), "Invalid exact Fal model namespace");
  requireCondition(/^[a-f0-9]{64}$/.test(bodySha256) && sha(body) === bodySha256
    && body.length > 0 && body.length <= MAX_BYTES, "Exact bounded request bytes differ");
  const parsedInput: unknown = JSON.parse(body.toString("utf8"));
  requireCondition(parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput), "JSON request object required");
  requireCondition(typeof key === "string" && key.length > 0 && key.length <= 4096 && !/[\r\n]/.test(key), "Invalid private credential");
  requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300_000, "Timeout must be explicitly bounded to 1–300 seconds");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(evidenceDirectory);
  requireCondition(((await stat(directory)).mode & 0o077) === 0, "Evidence directory must be private");
  await preserveExact(join(directory, "request-original.json"), body);
  const url = `https://queue.fal.run/${model}`;
  // O_EXCL plus file/directory fsync precedes the one network operation.
  await writeNew(join(directory, "submission-started.json"), encoded({ kind: "fal-once-submission-started-v1",
    phase: "submission_started_no_retry", model, url, body_sha256: bodySha256, body_bytes: body.length,
    timeout_ms: timeoutMs, started_at: new Date().toISOString(), automatic_retries: 0, reservation_changed: false }));
  await syncDirectory(directory);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Bounded Fal submission deadline expired", "TimeoutError")), timeoutMs);
  let phase = "awaiting_http", httpStatus: number | undefined, partial: Buffer[] = [], received = 0;
  let responseSaved = false;
  try {
    const response = await fetcher(url, { method: "POST", headers: { Authorization: `Key ${key}`,
      "Content-Type": "application/json", "X-Fal-No-Retry": "1" }, body: body.toString("utf8"), redirect: "error", signal: controller.signal });
    httpStatus = response.status; phase = "reading_response";
    await writeNew(join(directory, "http-response.json"), encoded({ kind: "fal-once-http-response-v1", model,
      body_sha256: bodySha256, status: httpStatus, ok: response.ok, received_at: new Date().toISOString() }));
    await syncDirectory(directory);
    requireCondition(response.body, "HTTP response has no readable body");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        const room = MAX_BYTES - received;
        if (room > 0) partial.push(bytes.subarray(0, room));
        received += bytes.length;
        requireCondition(received <= MAX_BYTES, "Response exceeds private 32 MiB bound");
      }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(partial);partial = [];
    await writeNew(join(directory, "response-original.bin"), raw);
    await writeNew(join(directory, "response-receipt.json"), encoded({ kind: "fal-once-response-bytes-v1", status: httpStatus,
      complete: true, sha256: sha(raw), bytes: raw.length, body_sha256: bodySha256 }));
    await syncDirectory(directory);responseSaved = true;phase = "validating_acknowledgment";
    // Persist exact HTTP errors before rejecting them. A provider error is never retried.
    requireCondition(response.ok, "Provider HTTP error preserved privately");
    const acknowledgment: unknown = JSON.parse(raw.toString("utf8"));
    requireCondition(acknowledgment && typeof acknowledgment === "object" && !Array.isArray(acknowledgment), "Acknowledgment must be a JSON object");
    const result = acknowledgment as Record<string, unknown>;
    requireCondition(typeof result.request_id === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(result.request_id), "Exact provider request identity unavailable");
    await writeNew(join(directory, "provider-acknowledgment.json"), encoded({ kind: "fal-once-provider-acknowledgment-v1",
      model, request_id: result.request_id, body_sha256: bodySha256, http_status: httpStatus,
      response_sha256: sha(raw), response_bytes: raw.length, queue_response: result, retries: 0 }));
    await syncDirectory(directory);
    return { request_id: result.request_id, model, body_sha256: bodySha256, http_status: httpStatus,
      response_sha256: sha(raw), queue_response: result, evidenceDirectory: directory, retries: 0 as const };
  } catch (error) {
    try {
      if (!responseSaved && partial.length) {
        const raw = Buffer.concat(partial);
        await writeNew(join(directory, "response-partial.bin"), raw);
        await writeNew(join(directory, "response-partial-receipt.json"), encoded({ complete: false, sha256: sha(raw), bytes: raw.length, received_bytes: received }));
      }
      await writeNew(join(directory, "submission-error.json"), encoded({ kind: "fal-once-submission-error-v1", status: "submission_unknown",
        phase, model, body_sha256: bodySha256, http_status: httpStatus, aborted: controller.signal.aborted,
        error: errorEvidence(error, key), automatic_retries: 0, reservation_retained: true, at: new Date().toISOString() }));
      await syncDirectory(directory);
    } catch { /* The immutable started marker still forbids another POST if storage itself failed. */ }
    throw new FalOnceSubmissionUnknownError(bodySha256, directory);
  } finally { clearTimeout(timer); }
}
