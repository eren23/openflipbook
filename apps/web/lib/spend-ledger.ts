import type { Collection, Document } from "mongodb";
import type { GenerateRequestBody } from "@openflipbook/config";

import { getDb } from "./db";
import { projectCost, type CostAction, type CostBundle } from "./cost-estimate";

/**
 * Durable, cross-container spend cap — the front-door counterpart to the Modal
 * backend's per-container in-process meter. All paid generations flow through
 * /api/generate-page, so a Mongo-backed daily + per-session ledger here is a
 * true GLOBAL cap that survives restarts and is shared across replicas.
 *
 * Estimate-based and enforced PRE-flight (refuse before spending), which is
 * exactly what a safety cap wants. Uses the same MAX_DAILY_SPEND /
 * MAX_SESSION_SPEND env names as the backend so one value configures both
 * layers. Both default off → no behaviour change for default deploys.
 */

const COLLECTION = "spend_ledger";

interface LedgerDoc extends Document {
  _id: string; // "day:YYYY-MM-DD" | "sess:<sessionId>:YYYY-MM-DD"
  total: number;
  updated_at: Date;
}

async function ledger(): Promise<Collection<LedgerDoc>> {
  return (await getDb()).collection<LedgerDoc>(COLLECTION);
}

function configured(): boolean {
  return Boolean(process.env.MONGODB_URI && process.env.MONGODB_DB);
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyCap(): number {
  return Math.max(0, Number(process.env.MAX_DAILY_SPEND) || 0);
}

function sessionCap(): number {
  return Math.max(0, Number(process.env.MAX_SESSION_SPEND) || 0);
}

async function totalFor(id: string): Promise<number> {
  const doc = await (await ledger()).findOne({ _id: id });
  return doc?.total ?? 0;
}

/**
 * A human reason if a durable cap is already crossed, else null. No-op (null)
 * when both caps are unset or Mongo isn't configured.
 */
export async function spendOverCap(sessionId: string): Promise<string | null> {
  if (!configured()) return null;
  const dCap = dailyCap();
  const sCap = sessionCap();
  if (dCap <= 0 && sCap <= 0) return null;
  const day = utcDay();
  if (dCap > 0) {
    const d = await totalFor(`day:${day}`);
    if (d >= dCap) {
      return `daily cap reached (≈$${d.toFixed(2)} of $${dCap.toFixed(2)})`;
    }
  }
  if (sCap > 0) {
    const s = await totalFor(`sess:${sessionId}:${day}`);
    if (s >= sCap) {
      return `session cap reached (≈$${s.toFixed(2)} of $${sCap.toFixed(2)})`;
    }
  }
  return null;
}

/** Add an estimated cost to the day + session ledgers (atomic upsert $inc). */
export async function recordSpend(
  sessionId: string,
  amount: number,
): Promise<void> {
  if (!configured() || amount <= 0) return;
  const day = utcDay();
  const col = await ledger();
  const now = new Date();
  await Promise.all([
    col.updateOne(
      { _id: `day:${day}` },
      { $inc: { total: amount }, $set: { updated_at: now } },
      { upsert: true },
    ),
    col.updateOne(
      { _id: `sess:${sessionId}:${day}` },
      { $inc: { total: amount }, $set: { updated_at: now } },
      { upsert: true },
    ),
  ]);
}

/**
 * Estimate one generation's cost from the request — the `low` (single-shot)
 * figure, enough to bound runaway abuse without false-blocking normal use.
 */
export function estimateGenerationCost(body: GenerateRequestBody): number {
  const bundle: CostBundle = {
    tier: body.image_tier ?? "balanced",
    maxAttempts: body.max_attempts ?? 2,
    verify: body.verify ?? true,
  };
  const action: CostAction =
    body.mode === "edit"
      ? "edit"
      : !body.mode || body.mode === "query"
        ? "query"
        : "tap";
  return projectCost(bundle, action).low;
}
