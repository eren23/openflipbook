/**
 * First-run coach visibility — the on-ramp decision, kept pure so it can be
 * unit-tested without a DOM. The PRE hint (the empty-query-box nudge) is the
 * one piece a brand-new visitor was missing: the POST chip already shows once
 * for everyone on their first page, but the PRE hint used to be gated OFF
 * behind NEXT_PUBLIC_ON_RAMP_COACH, so a first-timer faced a blank form with no
 * guidance. Now it shows ONCE for genuine first-timers and stays out of a
 * returning user's way.
 */

/** Tri-state flag parse: explicit on / off, or null when unset or unrecognised. */
export function parseCoachFlag(raw: string | null | undefined): boolean | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  return null;
}

export interface CoachPreInput {
  /** `?coach=0|1` URL param — pins the coach for demos / the UX bench. */
  urlParam?: string | null;
  /** NEXT_PUBLIC_ON_RAMP_COACH build flag. */
  envValue?: string | null;
  /** A prior session / dismissal was already in localStorage at mount. */
  hadPriorUse: boolean;
  /** The user explicitly dismissed the coach (persisted). */
  dismissed: boolean;
}

/**
 * Should the PRE first-run coach show by default? Precedence:
 *   1. explicit URL `?coach=` wins (demos / bench pin it on or off),
 *   2. else an explicit env flag wins (a self-hoster's opt-in/out — back-compat),
 *   3. else show ONCE for a genuine first-timer (no prior use, not dismissed).
 * A returning user with no override defaults OFF — their muscle memory is
 * unchanged, which is the whole point of keeping the on-ramp additive.
 */
export function coachPreDefault({
  urlParam,
  envValue,
  hadPriorUse,
  dismissed,
}: CoachPreInput): boolean {
  const url = parseCoachFlag(urlParam);
  if (url !== null) return url;
  const env = parseCoachFlag(envValue);
  if (env !== null) return env;
  return !hadPriorUse && !dismissed;
}
