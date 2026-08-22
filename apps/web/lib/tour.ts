// Tour mode's pure half: turn a session's node graph into a playable
// sequence. The story a world already tells — every page plus the exact
// spot that was tapped to descend — becomes a camera script: HOLD on a
// page, then DIVE into the tap point and crossfade to the child. No model
// calls, no new data; the graph is the screenplay.

export interface TourNode {
  id: string;
  parent_id: string | null;
  page_title: string;
  image_url: string;
  click_in_parent: { x_pct: number; y_pct: number } | null;
  relation?: "descend" | "expand" | "ascend" | "edit" | null;
  created_at: string;
}

export interface TourStep {
  node: TourNode;
  /** How the camera leaves this step toward the next:
   *  "dive" — zoom into `target` (the NEXT node's tap point on THIS image),
   *  "cut"  — plain crossfade (branch jump / no tap point recorded),
   *  "end"  — last step. */
  exit: "dive" | "cut" | "end";
  target: { x_pct: number; y_pct: number } | null;
}

/** Depth-first, creation-ordered walk from the earliest root — the order the
 *  world was actually explored. Edits are skipped (they revise a page, not
 *  visit a place). Orphans (parent outside the fetched window) tour as
 *  roots rather than vanish. */
export function buildTour(nodes: TourNode[]): TourStep[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, TourNode[]>();
  const roots: TourNode[] = [];
  const byCreated = (a: TourNode, b: TourNode) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  for (const n of [...nodes].sort(byCreated)) {
    if (n.relation === "edit") continue;
    if (n.parent_id && byId.has(n.parent_id)) {
      const list = children.get(n.parent_id) ?? [];
      list.push(n);
      children.set(n.parent_id, list);
    } else {
      roots.push(n);
    }
  }
  const order: TourNode[] = [];
  const visit = (n: TourNode) => {
    order.push(n);
    for (const c of children.get(n.id) ?? []) visit(c);
  };
  for (const r of roots) visit(r);

  return order.map((node, i) => {
    const next = order[i + 1];
    if (!next) return { node, exit: "end" as const, target: null };
    if (next.parent_id === node.id && next.click_in_parent) {
      return { node, exit: "dive" as const, target: next.click_in_parent };
    }
    return { node, exit: "cut" as const, target: null };
  });
}
