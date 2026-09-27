import type { ClientSession, Db } from "mongodb";
import { CreatorError } from "./creator-error";

// The caller owns authorization and the transaction containing the new job.
export async function reserveGenerationSpend(db: Db, session: ClientSession, sid: string, kind: string, amount: number, capName: string, now = new Date(), defaultKindCap = "4") {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10) throw new CreatorError("Invalid generation reservation", 400);
  const cap = (name: string, fallback: string, allowZero: boolean) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0 || !allowZero && value === 0) throw new CreatorError("Asset generation spend cap is invalid", 503);
    return value;
  };
  const caps = [cap("MAX_DAILY_SPEND", "0", true), cap("MAX_SESSION_SPEND", "0", true), cap(capName, defaultKindCap, false)];
  const day = now.toISOString().slice(0, 10), ids = [`day:${day}`, `sess:${sid}:${day}`, `${kind}:${day}`];
  const ledger = db.collection<{ _id: string; total: number }>("spend_ledger"), options = { session };
  for (const [i, id] of ids.entries()) {
    const old = await ledger.findOne({ _id: id }, options);
    if (caps[i]! > 0 && (old?.total ?? 0) + amount > caps[i]!) throw new CreatorError("Generation spend cap reached", 429);
    await ledger.updateOne({ _id: id }, { $inc: { total: amount } }, { ...options, upsert: true });
  }
  return ids;
}
