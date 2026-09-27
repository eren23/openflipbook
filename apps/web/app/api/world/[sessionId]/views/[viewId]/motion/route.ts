import { creatorRoute } from "@/lib/creator";
import { cameraMotionPreview } from "@/lib/camera-motion-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string; viewId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const { sessionId, viewId } = await params;
  return creatorRoute(() => cameraMotionPreview(sessionId, viewId));
}
