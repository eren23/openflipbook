// Where-am-I trail for the play page. Walk a node's parent chain up to the root
// so the user always sees "City › Unseen University › Tower of Art" and can jump
// straight back to any ancestor.

export interface Crumb {
  nodeId: string;
  title: string;
}

export interface BreadcrumbNode {
  nodeId: string | null;
  parentId?: string | null;
  title: string;
}

/**
 * Ancestry of `currentNodeId`, ordered [root … current]. Resolves parents from
 * `items` (the in-session visited pages). Cycle-guarded; stops at the first
 * ancestor that isn't loaded (e.g. a freshly continued session) — so it shows as
 * much of the path as it can rather than nothing.
 */
export function buildBreadcrumb(
  currentNodeId: string | null,
  items: BreadcrumbNode[],
): Crumb[] {
  if (!currentNodeId) return [];
  const byId = new Map<string, BreadcrumbNode>();
  for (const n of items) if (n.nodeId) byId.set(n.nodeId, n);

  const chain: Crumb[] = [];
  const seen = new Set<string>();
  let cur: BreadcrumbNode | undefined = byId.get(currentNodeId);
  while (cur && cur.nodeId && !seen.has(cur.nodeId)) {
    seen.add(cur.nodeId);
    chain.unshift({ nodeId: cur.nodeId, title: cur.title?.trim() || "Untitled" });
    const pid = cur.parentId ?? null;
    cur = pid ? byId.get(pid) : undefined;
  }
  return chain;
}
