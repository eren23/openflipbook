import {
  getNode,
  getPublishedSession,
  getSessionRootNode,
  type NodeRow,
  type PublishedSessionRow,
} from "./db";

// The embed surface's trust-boundary half, extracted from the page so the
// gate logic is unit-testable: the publish gate (a leaked session id must
// not make a private world frameable), the foreign-node rejection (a ?node=
// from another session must not smuggle a page into a published frame),
// and the `_from-node` sentinel public/embed.js mounts /n/ links with.

export interface EmbedStart {
  sessionId: string;
  published: PublishedSessionRow;
  start: NodeRow;
}

interface EmbedStores {
  getNode: typeof getNode;
  getPublishedSession: typeof getPublishedSession;
  getSessionRootNode: typeof getSessionRootNode;
}

const LIVE: EmbedStores = { getNode, getPublishedSession, getSessionRootNode };

/** Resolve what an /embed request may show, or null (the page 404s).
 *  All store failures degrade to null — the embed never leaks an error
 *  shape that distinguishes "private" from "absent". */
export async function resolveEmbedStart(
  sessionId: string,
  nodeParam: string | null | undefined,
  stores: EmbedStores = LIVE
): Promise<EmbedStart | null> {
  // public/embed.js mounts /n/<nodeId> permalinks as /embed/_from-node?node=…
  // (the script can't resolve node → session client-side). The publish gate
  // below applies to the RESOLVED session.
  if (sessionId === "_from-node") {
    const viaNode = nodeParam
      ? await stores.getNode(nodeParam).catch(() => null)
      : null;
    if (!viaNode) return null;
    sessionId = viaNode.session_id;
  }

  const published = await stores.getPublishedSession(sessionId).catch(() => null);
  if (!published) return null;

  let start: NodeRow | null = null;
  if (nodeParam) {
    const candidate = await stores.getNode(nodeParam).catch(() => null);
    if (candidate && candidate.session_id === sessionId) start = candidate;
  }
  if (!start) {
    start = await stores.getSessionRootNode(sessionId).catch(() => null);
  }
  if (!start) return null;

  return { sessionId, published, start };
}
