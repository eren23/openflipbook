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

/** Exact paid arrival bytes retained independently of the provider's URL. */
export interface StoredDescentVideo {
  version: 1;
  key: string;
  sha256: string;
  bytes: number;
  content_type: "video/mp4";
  parent_node_id: string;
  parent_image_key: string;
  node_image_key: string;
}

export function descentVideoPath(nodeId: string) {
  return `/api/nodes/${encodeURIComponent(nodeId)}/descent-video`;
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

/** Keep a clip on its node, and say so when that fails.
 *
 *  The clip is already paid for and already playing when this runs, so a
 *  failed save is invisible in the moment -- until the next visit, which bills
 *  fal again for the same clip. `fetch` resolves on a 4xx or 5xx, so a bare
 *  `.catch` saw none of them; a viewer who does not own the session gets a 403
 *  on every save. A failure goes to the same error sink the generate path
 *  uses, so it shows on /status instead of vanishing. Resolves to whether the
 *  clip was kept. */
export async function saveDescentClip(
  nodeId: string,
  url: string,
  send: typeof fetch = fetch,
  onSaved?: (keptUrl: string) => void,
): Promise<boolean> {
  const report = (message: string) =>
    send("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "client.descent_clip_save", message, source: "client" }),
    }).catch(() => undefined);
  try {
    const res = await send(`/api/nodes/${encodeURIComponent(nodeId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ descent_video_url: url }),
    });
    if (res.ok) {
      if (onSaved) {
        const receipt = await res.json().catch(() => null) as { kept?: unknown } | null;
        if (receipt?.kept === descentVideoPath(nodeId) || isDescentClipUrl(receipt?.kept)) onSaved(receipt.kept);
      }
      return true;
    }
    await report(`descent clip for ${nodeId} not saved: HTTP ${res.status}`);
  } catch (err) {
    await report(`descent clip for ${nodeId} not saved: ${String(err)}`);
  }
  return false;
}

/** Recognize historical external clips. New downloads additionally require
 *  a supported provider host on the server. */
export function isDescentClipUrl(url: unknown): url is string {
  return (
    typeof url === "string" &&
    url.length > 12 &&
    url.length <= 2048 &&
    url.startsWith("https://")
  );
}
