import { checkCreatorWrite, CreatorError, creatorRoute } from "@/lib/creator";
import { getOrCreateOwnerToken } from "@/lib/session-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Establish the credential before committing content. Losing a creation
// response must not lose the only copy of that world's ownership cookie.
export async function POST(req: Request) {
  return creatorRoute(async () => {
    checkCreatorWrite(req);
    if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) throw new CreatorError("Persistence is not configured", 503);
    await getOrCreateOwnerToken();
    return { ready: true };
  });
}
