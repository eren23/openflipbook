/**
 * Debug / observability GETs (recent errors, the backend trace buffer) return
 * stack traces and request-body excerpts — cross-tenant data that must not be
 * world-readable on a deployed instance. Closed on production unless a
 * `DEBUG_API_TOKEN` is configured AND presented via the `x-debug-token` header;
 * always open in local dev (not internet-exposed).
 */
export function debugAccessAllowed(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const token = process.env.DEBUG_API_TOKEN;
  if (!token) return false;
  return req.headers.get("x-debug-token") === token;
}
