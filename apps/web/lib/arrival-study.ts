import type { ViewVerdict } from "@openflipbook/config";
import { SPATIAL_STUDY_CASES } from "./spatial-study";
import { isVerifiedView } from "./place-identity";

export const ARRIVAL_POLICIES = ["context_first", "target_first"] as const;
export interface ArrivalCase {
  id: string; title: string; source: string; source_sha256: string; size: [number, number];
  click: { x_pct: number; y_pct: number };
  review: { bbox: [number, number, number, number]; features: string[]; entrance: string; provenance: "human_evaluation_only"; crop_sha256?: string };
  runtime_reference: { bbox: [number, number, number, number]; provenance: string; source_sha256: string; asset?: string } | null;
}
export interface ArrivalCell {
  id: string; case_id: string; policy: typeof ARRIVAL_POLICIES[number]; run: number;
  state: "not_submitted" | "reserved" | "submitted" | "complete" | "failed";
  arrival: ViewVerdict["arrival"] | null; human_review: { accepted: boolean; rationale: string } | null;
  view_verdict: ViewVerdict | null;
  visual_review?: { reviewer: "assistant"; accepted: boolean; rationale: string };
  output_sha256: string | null; reserved_usd?: string; error?: string;
}
export interface ArrivalReport {
  version: 1; fingerprint: string; approved_cap_usd: string; reserved_usd: string; status: string;
  model: string; cases: ArrivalCase[]; cells: ArrivalCell[];
}

export function arrivalAssetPath(name: string): string | null {
  const root = "tests/continuity_bench/reports/arrival-audit";
  if (name === "manifest.json") return `${root}/manifest.json`;
  for (const c of SPATIAL_STUDY_CASES) {
    if (name === c.source) return `tests/click_bench/fixtures/images/real/${c.source}`;
    if (name === `${c.id}-review.png`) return `${root}/${name}`;
    for (const policy of ARRIVAL_POLICIES) for (const run of [1, 2]) {
      if (name === `${c.id}-${policy}-${run}-candidate.png` || name === `${c.id}-${policy}-${run}-runtime.png`) return `${root}/${name}`;
    }
  }
  return null;
}

export function arrivalStatus(cell: ArrivalCell): string {
  if (cell.state !== "complete") return cell.state.replaceAll("_", " ");
  if (!cell.output_sha256 || !isVerifiedView(cell.view_verdict, { exterior: true })) return "Not verified";
  if (!cell.human_review) return "Human review pending";
  return cell.human_review.accepted ? "Reviewed pass" : "Human review failed";
}
