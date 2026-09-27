// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import type { ClientSession, Db, Document } from "mongodb";
const memory = vi.hoisted(() => ({ rows: new Map<string, Document[]>(), failure: "", tail: Promise.resolve(), session: {} as ClientSession }));
function collection(name: string) {
  const all = () => memory.rows.get(name) ?? [];
  const find = (query: Document) => all().find(row => Object.entries(query).every(([key, value]) => row[key] === value));
  const fail = (options: Document) => { expect(options.session).toBe(memory.session); if (memory.failure === name) throw new Error("Injected write failure"); };
  return {
    findOne: async (query: Document) => structuredClone(find(query) ?? null),
    insertOne: async (doc: Document, options: Document) => { fail(options); if (find({ _id: doc._id })) throw Object.assign(new Error("Duplicate"), { code: 11000 }); memory.rows.set(name, [...all(), structuredClone(doc)]); },
    updateOne: async (query: Document, update: Document, options: Document) => { fail(options); const row = find(query); if (row) Object.assign(row, structuredClone(update.$set)); return { matchedCount: row ? 1 : 0 }; },
  };
}
vi.mock("./db", () => ({ getDb: async () => ({ collection }), withDbTransaction: async (run: (db: Db, session: ClientSession) => Promise<unknown>) => {
  const previous = memory.tail; let release!: () => void; memory.tail = new Promise<void>(r => { release = r; }); await previous;
  const before = structuredClone(memory.rows);
  try { return await run({ collection } as unknown as Db, memory.session); } catch (error) { memory.rows = before; throw error; } finally { release(); }
} }));
import { inspectOwnerRecovery, issueOwnerRecovery, redeemOwnerRecovery, revokeOwnerRecovery } from "./owner-recovery";
import { parseRecoveryCommand } from "../scripts/owner-recovery";
const owners = () => memory.rows.get("session_owners")!;
const grants = () => memory.rows.get("owner_recovery_grants") ?? [];
beforeEach(() => {
  memory.rows.clear(); memory.failure = ""; memory.tail = Promise.resolve();
  memory.rows.set("session_owners", [{ _id: "world", owner_token: "old-browser", created_at: new Date(0) }, { _id: "other-old", owner_token: "old-browser" }, { _id: "receiver-world", owner_token: "new-browser" }]);
  memory.rows.set("creator_notes", [{ _id: "note", session_id: "world", text: "Private creator note", revision: 2 }]);
  memory.rows.set("place_scenes", [{ _id: "scene", session_id: "world", revision: 3 }]);
});
it("issues a scoped, expiring secret without changing access or storing plaintext credentials", async () => {
  const grant = await issueOwnerRecovery("world", "Verified creator", 15);
  expect(grant.code).toMatch(/^ofbr1_[a-f0-9]{32}\.[a-f0-9]{64}$/);
  expect(Date.parse(grant.expires_at) - Date.now()).toBeGreaterThan(14 * 60_000);
  expect(owners()[0]).toMatchObject({ owner_token: "old-browser", recovery_id: grant.grant_id });
  expect(grants()[0]).toMatchObject({ session_id: "world", status: "pending", reason: "Verified creator" });
  expect(JSON.stringify(grants())).not.toContain(grant.code); expect(JSON.stringify(grants())).not.toContain("old-browser");
  const inspected = await inspectOwnerRecovery("world"); expect(inspected.grant?.id).toBe(grant.grant_id);
  expect(JSON.stringify(inspected)).not.toMatch(/old-browser|secret_hash|previous_owner_hash|ofbr1_/);
});
it("transfers one world, preserves notes/content and both browsers' unrelated worlds", async () => {
  const before = structuredClone(memory.rows), grant = await issueOwnerRecovery("world", "Lost cookie");
  expect(await redeemOwnerRecovery(grant.code, "new-browser")).toEqual({ session_id: "world", recovered: true });
  expect(owners()[0]).toMatchObject({ owner_token: "new-browser", recovery_id: null, created_at: new Date(0) });
  expect(owners().slice(1)).toEqual(before.get("session_owners")!.slice(1));
  expect(memory.rows.get("creator_notes")).toEqual(before.get("creator_notes")); expect(memory.rows.get("place_scenes")).toEqual(before.get("place_scenes"));
  expect([...memory.rows.keys()].sort()).toEqual(["creator_notes", "owner_recovery_grants", "place_scenes", "session_owners"]);
  expect(grants()[0]!.status).toBe("used"); expect(JSON.stringify(grants())).not.toContain("new-browser");
});
it("permits same-browser lost-response replay but never transfers the used code again", async () => {
  const grant = await issueOwnerRecovery("world", "Lost response");
  const first = await redeemOwnerRecovery(grant.code, "new-browser"), before = structuredClone(memory.rows);
  expect(await redeemOwnerRecovery(grant.code, "new-browser")).toEqual(first); expect(memory.rows).toEqual(before);
  await expect(redeemOwnerRecovery(grant.code, "old-browser")).rejects.toMatchObject({ status: 403 });
  await expect(redeemOwnerRecovery(grant.code, "third-browser")).rejects.toMatchObject({ status: 403 });
  owners()[0]!.owner_token = "later-owner";
  await expect(redeemOwnerRecovery(grant.code, "new-browser")).rejects.toMatchObject({ status: 403 });
});
it("serializes competing redeemers and concurrent operator grants", async () => {
  const [old, grant] = await Promise.all([issueOwnerRecovery("world", "First"), issueOwnerRecovery("world", "Replacement")]);
  expect(grants()[0]!.status).toBe("revoked"); await expect(redeemOwnerRecovery(old.code, "new-browser")).rejects.toMatchObject({ status: 403 });
  const outcomes = await Promise.allSettled([redeemOwnerRecovery(grant.code, "new-browser"), redeemOwnerRecovery(grant.code, "third-browser")]);
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(owners()[0]!.owner_token).toBe("new-browser");
});
it("revokes pending grants idempotently without changing ownership", async () => {
  const grant = await issueOwnerRecovery("world", "Issued in error");
  const result = await revokeOwnerRecovery(grant.grant_id, "Cancelled by operator");
  expect(await revokeOwnerRecovery(grant.grant_id, "Repeated command")).toEqual(result);
  expect(owners()[0]!.owner_token).toBe("old-browser"); expect(grants()[0]!.revoke_reason).toBe("Cancelled by operator");
  await expect(redeemOwnerRecovery(grant.code, "new-browser")).rejects.toMatchObject({ status: 403 });
});
it("does not revoke a replacement grant or undo a completed recovery", async () => {
  const old = await issueOwnerRecovery("world", "First"), next = await issueOwnerRecovery("world", "New");
  await revokeOwnerRecovery(old.grant_id, "Revoke old only"); expect(owners()[0]!.recovery_id).toBe(next.grant_id);
  await redeemOwnerRecovery(next.code, "new-browser");
  await expect(revokeOwnerRecovery(next.grant_id, "Too late")).rejects.toMatchObject({ status: 409 });
});
it.each(["expired", "changed-owner", "missing-owner", "wrong-secret", "bad-hash", "missing-cookie"])("rejects %s without partial mutation", async variant => {
  const grant = await issueOwnerRecovery("world", "Validation case");
  if (variant === "expired") grants()[0]!.expires_at = new Date(Date.now() - 1);
  if (variant === "changed-owner") owners()[0]!.owner_token = "changed";
  if (variant === "missing-owner") memory.rows.set("session_owners", owners().slice(1));
  if (variant === "bad-hash") grants()[0]!.secret_hash = "corrupt";
  const before = structuredClone(memory.rows);
  const code = variant === "wrong-secret" ? grant.code.slice(0, -1) + (grant.code.endsWith("0") ? "1" : "0") : grant.code;
  await expect(redeemOwnerRecovery(code, variant === "missing-cookie" ? null : "new-browser")).rejects.toMatchObject({ status: variant === "missing-cookie" ? 409 : 403 });
  expect(memory.rows).toEqual(before);
});
it.each(["session_owners", "owner_recovery_grants"])("rolls back issue, use and revoke on a %s failure", async name => {
  let before = structuredClone(memory.rows); memory.failure = name;
  await expect(issueOwnerRecovery("world", "Fail issue")).rejects.toThrow(); expect(memory.rows).toEqual(before);
  memory.failure = ""; const grant = await issueOwnerRecovery("world", "Valid grant"); before = structuredClone(memory.rows); memory.failure = name;
  await expect(redeemOwnerRecovery(grant.code, "new-browser")).rejects.toThrow(); expect(memory.rows).toEqual(before);
  await expect(revokeOwnerRecovery(grant.grant_id, "Fail revoke")).rejects.toThrow(); expect(memory.rows).toEqual(before);
  memory.failure = ""; expect((await redeemOwnerRecovery(grant.code, "new-browser")).recovered).toBe(true);
});
it("rejects malformed requests, unowned worlds and invalid operator arguments", async () => {
  for (const code of [null, {}, "", "ofbr1_" + "a".repeat(5000)]) await expect(redeemOwnerRecovery(code, "new-browser")).rejects.toMatchObject({ status: 403 });
  await expect(issueOwnerRecovery("unowned", "No claim")).rejects.toMatchObject({ status: 404 });
  await expect(inspectOwnerRecovery("unowned")).rejects.toMatchObject({ status: 404 });
  await expect(issueOwnerRecovery("../world", "Bad id")).rejects.toMatchObject({ status: 400 });
  for (const minutes of [0, 1.5, NaN, 1441]) await expect(issueOwnerRecovery("world", "Bad expiry", minutes)).rejects.toMatchObject({ status: 400 });
  for (const reason of ["", "   ", "x".repeat(301)]) await expect(issueOwnerRecovery("world", reason)).rejects.toMatchObject({ status: 400 });
  await expect(revokeOwnerRecovery("bad", "Bad id")).rejects.toMatchObject({ status: 400 });
  expect(grants()).toEqual([]);
});
it("CLI requires explicit issue/revoke intent and does not default to a mutation", () => {
  expect(parseRecoveryCommand(["--help"])).toEqual({ action: "help" });
  expect(parseRecoveryCommand(["inspect", "--world", "world"])).toEqual({ action: "inspect", world: "world" });
  expect(parseRecoveryCommand(["issue", "--world", "world", "--reason", "Verified"])).toEqual({ action: "issue", world: "world", reason: "Verified", minutes: 15 });
  expect(parseRecoveryCommand(["revoke", "--grant", "id", "--reason", "Cancelled"])).toEqual({ action: "revoke", grant: "id", reason: "Cancelled" });
  for (const args of [[], ["world"], ["issue", "--world", "world"], ["inspect", "--world", "world", "--reason", "Unexpected"], ["revoke", "--world", "world", "--reason", "Wrong target"]]) expect(() => parseRecoveryCommand(args)).toThrow();
});
