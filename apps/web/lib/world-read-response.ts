import { NextResponse } from "next/server";
import { CreatorError } from "./creator-error";
import { requireWorldRead } from "./world-access";

// Cookie-authorized reads must never enter a shared cache. Legacy unlisted
// worlds still pass requireWorldRead without an ownership cookie.
export const worldReadHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function worldReadResponse(sessionId: string): Promise<NextResponse | null> {
  try {
    await requireWorldRead(sessionId);
    return null;
  } catch (error) {
    return NextResponse.json({ error: error instanceof CreatorError ? error.message : "World unavailable" }, {
      status: error instanceof CreatorError ? error.status : 503,
      headers: worldReadHeaders,
    });
  }
}
