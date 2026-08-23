// The travelogue: a session's node graph retold as a journey log — the
// atlas's readable half. Pure and creation-ordered; each entry names the
// move the explorer actually made (the relation) and where it happened from.

export interface TravelogueNode {
  id: string;
  parentId: string | null;
  title: string;
  createdAt: string;
  relation?: "descend" | "expand" | "ascend" | "edit" | null;
}

export interface TravelogueEntry {
  nodeId: string;
  ts: string;
  /** The sentence fragment after the timestamp, e.g.
   *  "entered The Tower from The Map". */
  line: string;
}

const VERBS: Record<string, string> = {
  descend: "entered",
  expand: "drifted over to",
  ascend: "rose out to",
  edit: "reshaped",
};

export function buildTravelogue(nodes: TravelogueNode[]): TravelogueEntry[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [...nodes]
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    )
    .map((n) => {
      const parent = n.parentId ? byId.get(n.parentId) : null;
      if (!parent) {
        return { nodeId: n.id, ts: n.createdAt, line: `arrived in ${n.title}` };
      }
      const verb = VERBS[n.relation ?? "descend"] ?? "entered";
      return {
        nodeId: n.id,
        ts: n.createdAt,
        line: `${verb} ${n.title} from ${parent.title}`,
      };
    });
}
