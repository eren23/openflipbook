import { getDb } from "./db";
import { requireCreator } from "./creator";

// Legacy image worlds retain their unlisted-link behavior. New authored worlds
// are private until an explicit publication workflow exists for them.
export async function requireWorldRead(sessionId: string) {
  const metadata = await (await getDb()).collection<{ _id: string; visibility?: string }>("creator_worlds").findOne({ _id: sessionId });
  if (metadata?.visibility === "private") await requireCreator(sessionId);
}
