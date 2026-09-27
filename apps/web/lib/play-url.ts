/** Keep the live explorer reloadable; /n/ is the separate read-only share page. */
export function playNodeUrl(sessionId: string, nodeId: string): string {
  return `/play?${new URLSearchParams({ continue: sessionId, node: nodeId })}`;
}
