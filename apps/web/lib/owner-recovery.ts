import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb, withDbTransaction } from "./db";
import { CreatorError } from "./creator-error";
import { isSafeId } from "./ids";

interface Owner { _id: string; owner_token: string; recovery_id?: string | null; recovered_at?: Date }
interface Grant {
  _id: string; session_id: string; secret_hash: string; previous_owner_hash: string;
  status: "pending" | "used" | "revoked"; issued_at: Date; expires_at: Date; reason: string;
  recipient_hash?: string; used_at?: Date; revoked_at?: Date; revoke_reason?: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new CreatorError("Recovery code is invalid, expired or no longer active", 403);
const transactionOptions = { readConcern: { level: "snapshot" as const }, writeConcern: { w: "majority" as const } };
function reasonText(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 300) throw new CreatorError("An operator reason of 1-300 characters is required", 400);
  return value.trim();
}

// Operator-only entry point. No HTTP route issues grants or exposes owner tokens.
export async function issueOwnerRecovery(sessionId: string, reason: string, minutes = 15) {
  if (!isSafeId(sessionId)) throw new CreatorError("Invalid world id", 400);
  const note = reasonText(reason);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new CreatorError("Expiry must be 1-1440 minutes", 400);
  const id = randomBytes(16).toString("hex"), code = `ofbr1_${id}.${randomBytes(32).toString("hex")}`;
  const now = new Date(), expires = new Date(now.getTime() + minutes * 60_000);
  await withDbTransaction(async (db, session) => {
    const options = { session }, owners = db.collection<Owner>("session_owners"), grants = db.collection<Grant>("owner_recovery_grants");
    const owner = await owners.findOne({ _id: sessionId }, options);
    if (!owner?.owner_token) throw new CreatorError("World has no existing ownership record; recovery cannot claim it", 404);
    if (owner.recovery_id) await grants.updateOne({ _id: owner.recovery_id, status: "pending" }, { $set: { status: "revoked", revoked_at: now, revoke_reason: "Superseded by an operator-issued grant" } }, options);
    await grants.insertOne({ _id: id, session_id: sessionId, secret_hash: hash(code), previous_owner_hash: hash(owner.owner_token), status: "pending", issued_at: now, expires_at: expires, reason: note }, options);
    // The owner document serializes concurrent issue/redeem operations. Only the
    // latest grant may transfer this world, even if the old owner token is unchanged.
    const updated = await owners.updateOne({ _id: sessionId, owner_token: owner.owner_token }, { $set: { recovery_id: id } }, options);
    if (updated.matchedCount !== 1) throw new CreatorError("Ownership changed; inspect the world again", 409);
  }, transactionOptions);
  return { grant_id: id, session_id: sessionId, code, expires_at: expires.toISOString() };
}

export async function inspectOwnerRecovery(sessionId: string) {
  if (!isSafeId(sessionId)) throw new CreatorError("Invalid world id", 400);
  const db = await getDb(), owner = await db.collection<Owner>("session_owners").findOne({ _id: sessionId });
  if (!owner?.owner_token) throw new CreatorError("World has no existing ownership record", 404);
  const grant = owner.recovery_id ? await db.collection<Grant>("owner_recovery_grants").findOne({ _id: owner.recovery_id }) : null;
  return { session_id: sessionId, has_owner: true, recovered_at: owner.recovered_at?.toISOString() ?? null,
    grant: grant ? { id: grant._id, status: grant.status, expires_at: grant.expires_at.toISOString(), reason: grant.reason } : null };
}

export async function revokeOwnerRecovery(id: string, reason: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new CreatorError("Invalid grant id", 400);
  const note = reasonText(reason);
  return withDbTransaction(async (db, session) => {
    const options = { session }, grants = db.collection<Grant>("owner_recovery_grants"), owners = db.collection<Owner>("session_owners");
    const grant = await grants.findOne({ _id: id }, options);
    if (!grant) throw new CreatorError("Recovery grant not found", 404);
    if (grant.status === "used") throw new CreatorError("Recovery was already used; issue a new grant to transfer access again", 409);
    if (grant.status !== "revoked") await grants.updateOne({ _id: id, status: "pending" }, { $set: { status: "revoked", revoked_at: new Date(), revoke_reason: note } }, options);
    await owners.updateOne({ _id: grant.session_id, recovery_id: id }, { $set: { recovery_id: null } }, options);
    return { grant_id: id, revoked: true };
  }, transactionOptions);
}

export async function redeemOwnerRecovery(code: unknown, token: string | null) {
  if (typeof code !== "string" || !/^ofbr1_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(code)) throw invalid();
  if (!token) throw new CreatorError("Initialize this browser's workspace before recovering access", 409);
  const id = code.slice(6, 38), digest = hash(code), recipient = hash(token);
  return withDbTransaction(async (db, session) => {
    const options = { session }, grants = db.collection<Grant>("owner_recovery_grants"), owners = db.collection<Owner>("session_owners");
    const grant = await grants.findOne({ _id: id }, options);
    if (!grant || !/^[a-f0-9]{64}$/.test(grant.secret_hash) || !timingSafeEqual(Buffer.from(grant.secret_hash, "hex"), Buffer.from(digest, "hex"))) throw invalid();
    const owner = await owners.findOne({ _id: grant.session_id }, options);
    if (!owner?.owner_token) throw invalid();
    if (grant.status === "used") {
      if (grant.recipient_hash !== recipient || owner.owner_token !== token) throw invalid();
      return { session_id: grant.session_id, recovered: true };
    }
    const now = new Date();
    if (grant.status !== "pending" || !(grant.expires_at instanceof Date) || !Number.isFinite(grant.expires_at.getTime())
      || grant.expires_at <= now || owner.recovery_id !== id || hash(owner.owner_token) !== grant.previous_owner_hash) throw invalid();
    const updated = await owners.updateOne({ _id: grant.session_id, owner_token: owner.owner_token, recovery_id: id }, { $set: { owner_token: token, recovery_id: null, recovered_at: now } }, options);
    if (updated.matchedCount !== 1) throw invalid();
    const used = await grants.updateOne({ _id: id, status: "pending" }, { $set: { status: "used", recipient_hash: recipient, used_at: now } }, options);
    if (used.matchedCount !== 1) throw invalid();
    return { session_id: grant.session_id, recovered: true };
  }, transactionOptions);
}
