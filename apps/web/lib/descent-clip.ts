// DESCENT_AUTO: after an enter lands, the descent clip (parent map ->
// arrived page, the app's first+last-frame video) generates in the
// BACKGROUND and persists on the node — so replaying the arrival as a
// camera move is instant, once per edge instead of per view. Pure
// decision + validation logic here; the play page owns the effect.

export interface AutoDescendInput {
  enabled: boolean;
  nodeId: string | null;
  parentImage: string | null | undefined;
  currentImage: string | null | undefined;
  storedUrl: string | null | undefined;
  alreadyFired: boolean;
}

/** Fire the background clip exactly once per node: flag on, a real saved
 *  node, both frames present, nothing stored yet, not already in flight. */
export function shouldAutoDescend(input: AutoDescendInput): boolean {
  return Boolean(
    input.enabled &&
      input.nodeId &&
      input.parentImage &&
      input.currentImage &&
      !input.storedUrl &&
      !input.alreadyFired,
  );
}

/** The PATCH accepts only an https video URL of sane length — the field is
 *  served back verbatim to every future visitor of the node. */
export function isDescentClipUrl(url: unknown): url is string {
  return (
    typeof url === "string" &&
    url.length > 12 &&
    url.length <= 2048 &&
    url.startsWith("https://")
  );
}
