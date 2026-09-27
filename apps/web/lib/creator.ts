import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb, type NodeDoc } from "./db";
import { isSafeId } from "./ids";
import { getWorldMap } from "./world-map";
import { parseNote, parseWorldPatch, type AuthorNote, type WorldSummary } from "./creator-types";

import { CreatorError } from "./creator-error";
export { CreatorError } from "./creator-error";

export function creatorJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
}

export async function creatorRoute(run: () => Promise<unknown>) {
  try { return creatorJson(await run()); }
  catch (e) { return creatorJson({ error: e instanceof CreatorError ? e.message : "Workspace unavailable. Please try again." }, e instanceof CreatorError ? e.status : 503); }
}

export function checkCreatorOrigin(req: Request) {
  const origin = req.headers.get("origin");
  // Next may use an internal hostname in req.url; Host is the browser's destination.
  const destination = new URL(req.url);
  const host = req.headers.get("host") ?? destination.host;
  if (origin && origin !== `${destination.protocol}//${host}`) throw new CreatorError("Invalid origin", 403);
}

export function checkCreatorWrite(req: Request) {
  checkCreatorOrigin(req);
  if (!req.headers.get("content-type")?.includes("application/json")) throw new CreatorError("Expected JSON", 415);
}

async function ownerToken() {
  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) throw new CreatorError("Persistence is not configured", 503);
  return (await cookies()).get("ofb_owner")?.value ?? null;
}

// Unlike public content gates, creator reads must never mint cookies or claim a world.
export async function requireCreator(sessionId: string) {
  if (!isSafeId(sessionId)) throw new CreatorError("Invalid world id", 400);
  const token = await ownerToken();
  if (!token) throw new CreatorError("This world is not owned by this browser", 403);
  const db = await getDb();
  if (!await db.collection<{ _id: string; owner_token: string }>("session_owners").findOne({ _id: sessionId, owner_token: token })) throw new CreatorError("This world is not owned by this browser", 403);
  return db;
}

export async function listCreatorWorlds(url: URL) {
  const token = await ownerToken();
  if (!token) return { worlds: [], next_cursor: null };
  const offset = Number(url.searchParams.get("cursor") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new CreatorError("Invalid cursor", 400);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 160);
  const archive = url.searchParams.get("archived") === "true";
  const db = await getDb();
  const rows = await db.collection("session_owners").aggregate<{
    _id: string; title: string; image_key: string; node_count: number; pinned: boolean;
    archived: boolean; last_opened_at: Date; resume_node_id: string | null; resume_place_id: string | null; resume_view?:"walk"; place_count: number;
  }>([
    { $match: { owner_token: token } },
    { $lookup: { from: "nodes", let: { sid: "$_id" }, pipeline: [
      { $match: { $expr: { $eq: ["$session_id", "$$sid"] } } },
      { $sort: { created_at: 1, _id: 1 } },
      { $group: { _id: null, title: { $first: "$page_title" }, query: { $first: "$query" }, image_key: { $first: "$image_key" }, node_count: { $sum: 1 }, latest: { $last: "$_id" }, created_at: { $last: "$created_at" } } },
    ], as: "content" } },
    { $unwind: { path: "$content", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "place_scenes", let: { sid: "$_id" }, pipeline: [
      { $match: { $expr: { $eq: ["$session_id", "$$sid"] } } },
      { $sort: { updated_at: -1, _id: 1 } },
      { $group: { _id: null, title: { $first: "$definition.label" }, latest: { $first: "$place_id" }, updated_at: { $first: "$updated_at" }, count: { $sum: 1 } } },
    ], as: "places" } },
    { $set: { places: { $arrayElemAt: ["$places", 0] } } },
    { $match: { $or: [{ "content.node_count": { $gt: 0 } }, { "places.count": { $gt: 0 } }] } },
    { $lookup: { from: "creator_worlds", localField: "_id", foreignField: "_id", as: "metadata" } },
    { $set: { metadata: { $arrayElemAt: ["$metadata", 0] } } },
    { $project: {
      title: { $ifNull: ["$metadata.title", { $ifNull: ["$content.title", { $ifNull: ["$content.query", "$places.title"] }] }] },
      image_key: "$content.image_key", node_count: { $ifNull: ["$content.node_count", 0] }, place_count: { $ifNull: ["$places.count", 0] },
      pinned: { $ifNull: ["$metadata.pinned", false] }, archived: { $ifNull: ["$metadata.archived", false] },
      last_opened_at: { $ifNull: ["$metadata.last_opened_at", { $ifNull: ["$content.created_at", { $toDate: "$places.updated_at" }] }] },
      resume_node_id: { $ifNull: ["$metadata.resume_node_id", { $ifNull: ["$content.latest", null] }] },
      resume_place_id: { $ifNull: ["$metadata.resume_place_id", { $cond: [{ $gt: ["$content.node_count", 0] }, null, "$places.latest"] }] },
      resume_view: "$metadata.resume_view",
    } },
    { $match: { archived: archive, ...(query ? { title: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {}) } },
    { $sort: { pinned: -1, last_opened_at: -1, _id: 1 } }, { $skip: offset }, { $limit: 21 },
  ]).toArray();
  const base = process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
  const worlds: WorldSummary[] = rows.slice(0, 20).map(row => ({
    id: row._id, title: row.title || "Untitled world", image_url: base && row.image_key ? `${base}/${row.image_key}` : null,
    node_count: row.node_count, pinned: row.pinned, archived: row.archived,
    last_opened_at: row.last_opened_at.toISOString(), resume_node_id: row.resume_node_id ?? null,
    resume_place_id: row.resume_place_id ?? null, place_count: row.place_count ?? 0,
    resume_view: row.resume_view==="walk"?"walk":null,
  }));
  return { worlds, next_cursor: rows.length > 20 ? String(offset + 20) : null };
}

export async function updateCreatorWorld(sessionId: string, body: unknown) {
  const db = await requireCreator(sessionId);
  const patch = parseWorldPatch(body);
  if (!patch) throw new CreatorError("Invalid world update", 400);
  if (patch.resume_place_id) {
    if (!await db.collection("place_scenes").findOne({ session_id: sessionId, place_id: patch.resume_place_id })) throw new CreatorError("Saved place not found", 404);
  } else if (!await db.collection<NodeDoc>("nodes").findOne({ session_id: sessionId, ...(patch.resume_node_id ? { _id: patch.resume_node_id } : {}) })) {
    if (patch.resume_node_id || !await db.collection("place_scenes").findOne({ session_id: sessionId })) throw new CreatorError("Saved view not found", 404);
  }
  await db.collection<{ _id: string }>("creator_worlds").updateOne(
    { _id: sessionId }, { $set: { ...patch, ...(patch.resume_node_id || patch.resume_place_id ? { last_opened_at: new Date(), resume_view:null, ...(patch.resume_node_id ? { resume_place_id: null } : { resume_node_id: null }) } : {}) } }, { upsert: true },
  );
  return { saved: true };
}

interface NoteDoc { _id: string; session_id: string; place_id: string | null; label: string; text: string; revision: number; updated_at: Date }
const noteWire = (doc: NoteDoc): AuthorNote => ({ place_id: doc.place_id, label: doc.label, text: doc.text, revision: doc.revision, updated_at: doc.updated_at.toISOString() });

export async function readCreatorNotes(sessionId: string) {
  const db = await requireCreator(sessionId);
  const [notes, map] = await Promise.all([
    db.collection<NoteDoc>("creator_notes").find({ session_id: sessionId }).sort({ updated_at: -1 }).toArray(), getWorldMap(sessionId),
  ]);
  return { notes: notes.map(doc => {
    const place = map.entities.find(p => p.id === doc.place_id);
    return { ...noteWire(doc), label: place?.label ?? doc.label, missing_place: doc.place_id !== null && !place };
  }) };
}

export async function saveCreatorNote(sessionId: string, body: unknown) {
  const db = await requireCreator(sessionId);
  const input = parseNote(body);
  if (!input) throw new CreatorError("Invalid note (maximum 20,000 characters)", 400);
  const col = db.collection<NoteDoc>("creator_notes");
  const id = `${sessionId}:${input.place_id === null ? "world" : `place:${input.place_id}`}`;
  const previous = await col.findOne({ _id: id });
  const place = input.place_id ? (await getWorldMap(sessionId)).entities.find(p => p.id === input.place_id) : null;
  if (input.place_id && !place && !previous) throw new CreatorError("Place not found", 404);
  const doc: NoteDoc = { _id: id, session_id: sessionId, ...input, label: place?.label ?? previous?.label ?? "World notes", revision: input.revision + 1, updated_at: new Date() };
  if (input.revision === 0) {
    try { await col.insertOne(doc); }
    catch (e) { if ((e as { code?: number }).code === 11000) throw new CreatorError("This note changed in another tab. Review the saved version.", 409); throw e; }
  } else {
    const result = await col.replaceOne({ _id: id, revision: input.revision }, doc);
    if (!result.matchedCount) throw new CreatorError("This note changed in another tab. Review the saved version.", 409);
  }
  return { note: noteWire(doc) };
}
