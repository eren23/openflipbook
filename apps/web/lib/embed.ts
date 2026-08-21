// The embeddable-world surface's pure half: resolve an oEmbed `url` param to
// an embed target, and build the iframe snippet consumers paste. Kept free of
// I/O so the URL grammar is unit-testable (the /api/oembed route does the
// Mongo lookups + publish gating).

export type EmbedTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "session"; sessionId: string; nodeId: string | null };

/** Parse an oEmbed `url` parameter. Accepted shapes (any origin — consumers
 *  send whatever domain the deploy lives on):
 *    …/n/<nodeId>                     → the node's session, starting AT it
 *    …/embed/<sessionId>[?node=<id>] → that session (optional start node)
 *  Anything else → null. */
export function parseEmbedTarget(rawUrl: string): EmbedTarget | null {
  let url: URL;
  try {
    // Lenient on origin: the /n/ discovery link passes a relative path (the
    // server can't know its public origin at metadata time), and consumers
    // pass their own absolute page URLs. Both parse.
    url = new URL(rawUrl, "http://relative.local");
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0] === "n" && parts[1]) {
    return { kind: "node", nodeId: decodeURIComponent(parts[1]) };
  }
  if (parts.length === 2 && parts[0] === "embed" && parts[1]) {
    return {
      kind: "session",
      sessionId: decodeURIComponent(parts[1]),
      nodeId: url.searchParams.get("node"),
    };
  }
  return null;
}

export interface EmbedHtml {
  html: string;
  width: number;
  height: number;
}

/** The iframe snippet oEmbed consumers (and public/embed.js) inject. 16:10 to
 *  fit the image plus the viewer's slim chrome; capped by the consumer's
 *  maxwidth per the oEmbed spec. */
export function buildEmbedHtml(
  origin: string,
  sessionId: string,
  nodeId: string | null,
  maxWidth?: number | null
): EmbedHtml {
  const width = Math.min(Math.max(maxWidth ?? 720, 320), 1280);
  const height = Math.round(width * 0.625);
  const src =
    `${origin.replace(/\/$/, "")}/embed/${encodeURIComponent(sessionId)}` +
    (nodeId ? `?node=${encodeURIComponent(nodeId)}` : "");
  return {
    html:
      `<iframe src="${src}" width="${width}" height="${height}" ` +
      `frameborder="0" loading="lazy" allowfullscreen ` +
      `style="border:0;max-width:100%;border-radius:12px" ` +
      `title="openflipbook world"></iframe>`,
    width,
    height,
  };
}
