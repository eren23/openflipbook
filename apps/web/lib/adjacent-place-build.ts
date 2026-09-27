import { CreatorError, requireCreator } from "./creator";
import { isSafeId } from "./ids";
import { withDbTransaction } from "./db";
import { placeScenesEnabled } from "./place-scene-enabled";
import { commitPlaceScene, type ProposalDoc } from "./place-scene-server";
import { placeBuildBackend, placeBuildWorkerAvailable, type BuildDoc } from "./place-build-execution";
import { matchBuildRequest, parseBuildRequest, prepareBuildReservation, reservePlaceBuild, wireBuild } from "./place-build-reservation";

async function access(sid: string, sourcePid: string) {
  if (!placeScenesEnabled()) throw new CreatorError("World scenes are not enabled", 404);
  if (!isSafeId(sourcePid)) throw new CreatorError("Invalid source place", 400);
  return requireCreator(sid);
}
export async function adjacentBuildCapabilities(sid: string, sourcePid: string) {
  const db = await access(sid, sourcePid);
  try {
    const config = await placeBuildBackend("capabilities");
    if (!config.enabled || typeof config.model !== "string" || !config.model || config.model.length > 200 || !Number.isFinite(config.reservation) || config.reservation <= 0 || config.reservation > 10 || config.connection_context_version !== 1 || !await placeBuildWorkerAvailable(db, true)) return { capabilities: { enabled: false, reason: "Connected layout generation requires an enabled backend and updated layout workers." } };
    return { capabilities: { enabled: true, model: config.model, reservation: config.reservation } };
  } catch { return { capabilities: { enabled: false, reason: "Layout generation backend unavailable" } }; }
}

export async function generateAdjacentPlace(sid: string, sourcePid: string, input: Record<string, unknown>) {
  const db = await access(sid, sourcePid);
  if (!isSafeId(input.place_id) || !isSafeId(input.proposal_id)) throw new CreatorError("A reviewed adjoining area is required", 400);
  const pid = input.place_id, proposalId = input.proposal_id;
  const request = { ...parseBuildRequest({ ...input, id: `adjacent_${proposalId}`, base_revision: 1 }), expansion: { source_place_id: sourcePid, proposal_id: proposalId } };
  const key = `${sid}:${pid}:${request.id}`;
  const replay = (job: BuildDoc) => ({ place_id: pid, job: wireBuild(matchBuildRequest(job, request)) });
  // A lost acknowledgement can be recovered even if the provider is now offline
  // or the saved place has since been edited. Never schedule an old job again.
  const old = await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: key }); if (old) return replay(old);
  const config = await prepareBuildReservation(db, request);
  return withDbTransaction(async (db, session) => {
    const previous = await db.collection<BuildDoc>("place_build_jobs").findOne({ _id: key }, { session }); if (previous) return replay(previous);
    const proposal = await db.collection<ProposalDoc>("world_edit_proposals").findOne({ _id: proposalId, session_id: sid, place_id: pid }, { session });
    if (!proposal || proposal.base_revision !== 0 || proposal.applied_revision || proposal.connection?.a.place_id !== sourcePid || proposal.connection.b.place_id !== pid) throw new CreatorError("Review a new adjoining-area proposal before generating", 409);
    await commitPlaceScene(db, session, sid, pid, proposalId);
    const job = await reservePlaceBuild(db, session, sid, pid, request, config, true);
    return { place_id: pid, job: wireBuild(job) };
  });
}
