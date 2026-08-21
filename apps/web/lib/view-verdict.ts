import type { ViewVerdict } from "@openflipbook/config";

// The render receipt's display half. Buckets, not raw-number dumps: the
// judges are rankers (~0.6 Spearman), so a kept-best 6/10 must read as
// honest best-effort, never as an error banner — the "gorgeous mesa
// scored 2" lesson. Absent axes stay absent (that judge never ran).

export type VerdictBucket = "verified" | "best_effort";

export function verdictBucket(v: ViewVerdict): VerdictBucket {
  return v.accepted ? "verified" : "best_effort";
}

const AXIS_LABELS: [keyof ViewVerdict & string, string][] = [
  ["same_place", "same place"],
  ["conformance", "view"],
  ["medium", "medium"],
  ["detail", "detail"],
  ["interior", "interior"],
];

/** The axes that actually ran, as "label 9.0/10" fragments. */
export function verdictAxes(v: ViewVerdict): string[] {
  const out: string[] = [];
  for (const [key, label] of AXIS_LABELS) {
    const score = v[key];
    if (typeof score === "number") out.push(`${label} ${score.toFixed(1)}/10`);
  }
  return out;
}

/** One-line receipt for the chip. */
export function formatViewVerdict(v: ViewVerdict): string {
  const attempts = `${v.attempts} attempt${v.attempts === 1 ? "" : "s"}`;
  const axes = verdictAxes(v).join(" · ");
  return v.accepted
    ? `arrival verified — ${axes} · ${attempts}`
    : `best of ${attempts} — ${axes} (gates not all met)`;
}
