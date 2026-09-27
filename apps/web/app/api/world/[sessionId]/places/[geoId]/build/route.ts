import { checkCreatorWrite, creatorRoute, CreatorError } from "@/lib/creator";
import { placeBuildLibrary, queuePlaceBuild, runPlaceBuild, cancelPlaceBuild, previewPlaceBuild, revalidatePlaceBuild } from "@/lib/place-build-server";
import { queueBuildMaterials, replaceBuildMaterial, refreshBuildMaterial, cancelBuildMaterials, queueBuildAssets, replaceBuildAsset, refreshBuildAsset, cancelBuildAssets, queueBuildAppearance } from "@/lib/place-build-assets-server";
import { isSafeId } from "@/lib/ids";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
interface Params { params: Promise<{ sessionId: string; geoId: string }> }
export async function GET(_req: Request, { params }: Params) {
  const { sessionId, geoId } = await params; return creatorRoute(() => placeBuildLibrary(sessionId, geoId));
}
export async function POST(req: Request, { params }: Params) {
  const { sessionId, geoId } = await params;
  return creatorRoute(async () => {
    checkCreatorWrite(req); const text = await req.text();
    if (text.length > 8000) throw new CreatorError("Build request too large", 413);
    let body; try { body = JSON.parse(text); } catch { throw new CreatorError("Invalid JSON", 400); }
    if (body?.action === "queue") return queuePlaceBuild(sessionId, geoId, body);
    if (body?.action === "run") return runPlaceBuild(sessionId, geoId, body.id);
    if (body?.action === "revalidate") return revalidatePlaceBuild(sessionId, geoId, body.id);
    if (body?.action === "cancel") return cancelPlaceBuild(sessionId, geoId, body.id);
    if (body?.action === "preview") return previewPlaceBuild(sessionId, geoId, body.id, body.layout_only === true);
    if (body?.action === "appearance") return queueBuildAppearance(sessionId, geoId, body.id, body);
    if (body?.action === "materials") return queueBuildMaterials(sessionId, geoId, body.id, body);
    if (body?.action === "meshes") return queueBuildAssets(sessionId, geoId, body.id, body, "mesh");
    if (body?.action === "replace-mesh") return replaceBuildAsset(sessionId, geoId, body.id, body, "mesh");
    if (body?.action === "refresh-mesh") return refreshBuildAsset(sessionId, geoId, body.id, body.job_id, "mesh");
    if (body?.action === "cancel-meshes") return cancelBuildAssets(sessionId, geoId, body.id, "mesh");
    if (body?.action === "discard-mesh") {
      if (!isSafeId(body.job_id)) throw new CreatorError("Invalid mesh job", 400);
      return cancelBuildAssets(sessionId, geoId, body.id, "mesh", body.job_id);
    }
    if (body?.action === "replace-material") return replaceBuildMaterial(sessionId, geoId, body.id, body);
    if (body?.action === "refresh-material") return refreshBuildMaterial(sessionId, geoId, body.id, body.job_id);
    if (body?.action === "cancel-materials") return cancelBuildMaterials(sessionId, geoId, body.id);
    if (body?.action === "discard-material") {
      if (!isSafeId(body.job_id)) throw new CreatorError("Invalid material job", 400);
      return cancelBuildMaterials(sessionId, geoId, body.id, body.job_id);
    }
    throw new CreatorError("Unknown build action", 400);
  });
}
