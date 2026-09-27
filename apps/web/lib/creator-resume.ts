import { buildBreadcrumb } from "./breadcrumb";
import { nodeToPage, type SessionNodeWire } from "./session-pages";

export async function loadCreatorSession(sessionId: string, selected: string | null, signal: AbortSignal, request: typeof fetch = fetch) {
  const rows: SessionNodeWire[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res = await request(`/api/sessions/${encodeURIComponent(sessionId)}${query}`, { signal });
    if (!res.ok) throw new Error("Could not load saved world");
    const data = await res.json() as { nodes: SessionNodeWire[]; next_cursor?: string | null };
    if (!Array.isArray(data.nodes) || data.nodes.some(n => n.session_id !== sessionId)) throw new Error("Invalid saved world response");
    rows.push(...data.nodes);
    cursor = data.next_cursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error("Saved world pagination did not advance");
    if (cursor) cursors.add(cursor);
  } while (cursor && !signal.aborted);
  signal.throwIfAborted();
  const items = [...new Map(rows.map(row => [row.id, row])).values()].map(nodeToPage);
  const page = items.find(p => p.nodeId === selected) ?? items[items.length - 1];
  if (!page?.nodeId || !page.imageDataUrl) throw new Error("No saved views found");
  const trail = buildBreadcrumb(page.nodeId, items).map(c => c.nodeId);
  return { page, history: { items, trail, trailIdx: trail.length - 1 } };
}
