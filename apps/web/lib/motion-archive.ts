import { CreatorError } from "./creator-error";
import { viewHash } from "./place-view-store";
import { VIEW_PASSES } from "./place-view";
import type { MotionStudyDoc } from "./motion-study";
import type { MotionAssetDoc, MotionFile, MotionReviewDoc } from "./motion-job";

export interface MotionArchiveSnapshot {
  studies: MotionStudyDoc[];
  assets: MotionAssetDoc[];
  reviews: MotionReviewDoc[];
  selections: { _id: string; asset_id: string; review_id?: string }[];
}
export interface MotionArchiveExport extends MotionArchiveSnapshot {
  files: (MotionFile & { file: string; data: Uint8Array })[];
}

// All records come from one owner-authorized database snapshot. References to
// original storage keys are provenance only; imports never fetch those keys.
export async function downloadMotionArchive(snapshot: MotionArchiveSnapshot,
  required: (key: string, label: string, expected: MotionFile) => Promise<{ bytes: Uint8Array }>): Promise<MotionArchiveExport> {
  const studies = new Map(snapshot.studies.map(s => [s.id, s])), assets = new Map(snapshot.assets.map(a => [a.id, a]));
  const files = new Map<string, MotionArchiveExport["files"][number]>();
  async function include(file: MotionFile, extension: string) {
    if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new CreatorError("Invalid saved motion file", 409);
    const prior = files.get(file.key);
    if (prior) {
      if (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes) throw new CreatorError("Conflicting saved motion bytes", 409);
      return;
    }
    const stored = await required(file.key, "motion content", file);
    files.set(file.key, { ...file, file: `motion/${files.size + 1}.${extension}`, data: stored.bytes });
  }
  for (const study of snapshot.studies) {
    await include(study.source.image, "image");
    for (const frame of study.files) for (const pass of VIEW_PASSES) await include(frame[pass], "png");
  }
  for (const asset of snapshot.assets) {
    const study = studies.get(asset.study_id);
    if (!study || asset.study_sha256 !== viewHash(study)) throw new CreatorError("Motion clip does not match its saved study", 409);
    await include(asset.original, "mp4"); await include(asset.silent, "mp4");
  }
  for (const review of snapshot.reviews) {
    const asset = assets.get(review.asset_id);
    if (!asset || asset.study_id !== review.study_id || asset.silent.sha256 !== review.video_sha256 || asset.comparison?.sha256 !== review.comparison_sha256)
      throw new CreatorError("Motion review does not match its saved clip", 409);
  }
  for (const selection of snapshot.selections) {
    const asset = assets.get(selection.asset_id);
    if (!asset || selection._id !== `${asset.session_id}:${asset.study_id}` || selection.review_id && !snapshot.reviews.some(r => r.id === selection.review_id && r.asset_id === asset.id))
      throw new CreatorError("Selected motion clip or review is missing", 409);
  }
  return { ...snapshot, files: [...files.values()] };
}
