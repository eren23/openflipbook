import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { placeScenesEnabled } from "./place-scene-enabled";
import { assertCurrentView, viewHash, type PlaceViewDoc } from "./place-view-store";
import { parseCaptureMetadata } from "./place-view-server";
import { prepareCameraMotion } from "./camera-motion";
import { illustrationDependency } from "./illustration-input";
import type { MeshAssetDoc } from "./mesh-execution";
import type { ClientSession, Db } from "mongodb";

export async function cameraMotionPreview(sid: string, viewId: string) {
  if (!isSafeId(sid) || !isSafeId(viewId)) throw new CreatorError("Invalid camera view", 400);
  const db = await requireCreator(sid);
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  return prepareOwnedCameraMotion(db, sid, viewId);
}

export async function prepareOwnedCameraMotion(db: Db, sid: string, viewId: string, session?: ClientSession) {
  const options = session ? { session } : {};
  const view = await db.collection<PlaceViewDoc>("place_views").findOne({ _id: `${sid}:${viewId}`, session_id: sid }, options);
  if (!view) throw new CreatorError("Saved camera view not found", 404);
  const sources = await assertCurrentView(db, view, session);
  if (sources.some(source => source.definition.material_pack)) throw new CreatorError("Legacy atlas motion requires immutable asset bindings", 409);
  // Reuse the saved-view validator. No client-supplied pose, image URL or
  // claimed collision check can replace the owned immutable capture here.
  const capture = parseCaptureMetadata({ ...view, sources, passes: { render: "", depth: "", normals: "", objects: "" } });
  const motion = prepareCameraMotion(capture);
  const illustration = view.accepted_illustration_id
    ? await db.collection<MeshAssetDoc>("illustration_assets").findOne({ _id: `${sid}:${view.accepted_illustration_id}`, session_id: sid }, options) : null;
  if (view.accepted_illustration_id && (!illustration?.view_dependency || illustration.edit_input
    || viewHash(illustration.view_dependency) !== viewHash(illustrationDependency(view))))
    throw new CreatorError("Accepted artwork is missing or does not match this camera view", 409);
  const source = {
    view_id: view.id, view_input_sha256: view.request_sha256,
    image: { kind: illustration ? "accepted_illustration" as const : "render" as const,
      asset_id: illustration?.id ?? null, sha256: illustration?.sha256 ?? view.files.render.sha256,
      width: view.width, height: view.height },
    registration: "saved_camera_dependency_not_visual_attestation" as const,
    sources: view.sources, assets: view.assets,
  };
  // The fingerprint binds preparation, not authorization. A future submission
  // must recheck these dependencies, bytes, preflight and price transactionally.
  return { ...motion, source, preparation_sha256: viewHash({ motion, source }),
    generation_enabled: false, status: "calibration_required" as const };
}
