import type { EditVerdict } from "@openflipbook/config";

/** The verdict chip's text — what the judges saw on the kept attempt.
 *  Null scores (a degraded judge, or the not-applicable outside gate on
 *  whole-image edits) render as an em dash rather than pretending. */
export function formatEditVerdict(v: EditVerdict): string {
  const n = (x: number | null) => (x == null ? "—" : x.toFixed(1));
  const attempts = `${v.attempts} attempt${v.attempts === 1 ? "" : "s"}`;
  return v.accepted
    ? `edit verified ${n(v.alignment)}/10 · medium ${n(v.medium)}/10 · ${attempts}`
    : `edit kept best of ${attempts} — verification gates not all met`;
}
