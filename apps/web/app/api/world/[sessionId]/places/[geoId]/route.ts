import { NextResponse } from "next/server";
import { isSafeId } from "@/lib/ids";
import { parsePlaceUpdate } from "@/lib/place-identity";
import { PlaceError, updatePlace } from "@/lib/places";
import { getStoredBytes } from "@/lib/r2";
import { requireOwner } from "@/lib/session-owner";
import { getWorldMap } from "@/lib/world-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; geoId: string }> }

export async function PATCH(req: Request, { params }: Params) {
  const { sessionId, geoId } = await params;
  if (!isSafeId(sessionId) || !isSafeId(geoId)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const owner = await requireOwner(sessionId);
  if (!owner.ok) return owner.res;
  const patch = parsePlaceUpdate(await req.json().catch(() => null));
  if (!patch) return NextResponse.json({ error: "invalid place update" }, { status: 400 });
  try {
    return NextResponse.json({ place: await updatePlace(sessionId, geoId, patch) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof PlaceError ? error.message : "Could not save this place" }, { status: error instanceof PlaceError ? error.status : 503 });
  }
}

// References are read-only world content, like the existing image route. The
// storage key comes only from persisted metadata, never from a query parameter.
export async function GET(_req: Request, { params }: Params) {
  const { sessionId, geoId } = await params;
  if (!isSafeId(sessionId) || !isSafeId(geoId)) return new Response(null, { status: 400 });
  try {
    const anchor = (await getWorldMap(sessionId)).entities.find(e => e.id === geoId)?.identity_anchor;
    const stored = anchor ? await getStoredBytes(anchor.image_key) : null;
    if (!stored) return new Response(null, { status: 404 });
    if (!stored.contentType.startsWith("image/") || stored.bytes.length > 20 * 1024 * 1024) return new Response(null, { status: 422 });
    return new Response(new Uint8Array(stored.bytes), { headers: { "Content-Type": stored.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response(null, { status: 503 });
  }
}
