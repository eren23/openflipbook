/**
 * Session/node ids are client-supplied and flow into Mongo document `_id`s and —
 * for node ids — into entity MAP KEYS (`appearance_bboxes[nodeId]`,
 * `appearance_borders[nodeId]`). A value containing `.` (a Mongo dotted path) or
 * `$` (an operator) would corrupt the document or be rejected on write, so every
 * route boundary validates ids before they reach the store.
 *
 * The allowed set matches every id the app mints: `crypto.randomUUID()` (hex +
 * hyphens) and the `session_` / `geo_` prefixes — none of which contain `.`.
 */
export function isSafeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}
