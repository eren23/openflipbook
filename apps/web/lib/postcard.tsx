import type { ReactElement } from "react";

import { isRTL } from "./i18n";

export interface PostcardNode {
  nodeId: string;
  title: string;
  imageUrl: string;
  citationCount: number;
  locale?: string;
}

const WIDTH = 1080;
const HEIGHT = 1350;
const IMAGE_HEIGHT = 1010;
const PAPER = "#f4ead8";
const INK = "#2a1a08";

/**
 * Satori-compatible JSX for the magazine-card postcard. Pure presentational —
 * the route handler in `/api/postcard/[nodeId]` is responsible for sourcing
 * node + QR data url + base url and passing them in.
 */
export function postcardLayout(
  node: PostcardNode,
  baseUrl: string,
  qrDataUrl: string,
): ReactElement {
  const rtl = isRTL(node.locale ?? "en");
  const permalinkDisplay = `${stripScheme(baseUrl)}/n/${node.nodeId}`;
  return (
    <div
      dir={rtl ? "rtl" : "ltr"}
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        background: PAPER,
        color: INK,
        fontFamily: "Georgia, serif",
      }}
    >
      <img
        src={node.imageUrl}
        alt=""
        width={WIDTH}
        height={IMAGE_HEIGHT}
        style={{
          width: WIDTH,
          height: IMAGE_HEIGHT,
          objectFit: "cover",
          display: "flex",
        }}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          alignItems: "stretch",
          padding: "32px 44px",
          borderTop: "1px solid rgba(0,0,0,0.08)",
          gap: 28,
        }}
      >
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              fontSize: 38,
              fontWeight: 700,
              lineHeight: 1.18,
              letterSpacing: -0.5,
              display: "flex",
            }}
          >
            {node.title}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: 14,
              fontSize: 18,
              color: "rgba(42,26,8,0.65)",
              letterSpacing: 1.2,
              textTransform: "uppercase",
              fontFamily: "monospace",
            }}
          >
            <span style={{ display: "flex" }}>{permalinkDisplay}</span>
            {node.citationCount > 0 ? (
              <span style={{ display: "flex" }}>
                · {node.citationCount} {pluralSources(node.citationCount)}
              </span>
            ) : null}
          </div>
        </div>
        <img
          src={qrDataUrl}
          alt=""
          width={140}
          height={140}
          style={{ width: 140, height: 140, display: "flex" }}
        />
      </div>
    </div>
  );
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function pluralSources(n: number): string {
  return n === 1 ? "source" : "sources";
}
