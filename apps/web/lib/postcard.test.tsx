import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { postcardLayout } from "./postcard";
import type { PostcardNode } from "./postcard";

const node: PostcardNode = {
  nodeId: "4a9c1",
  title: "The Iron Spine — how a piston turns a wheel",
  imageUrl: "https://r2.example.test/pages/4a9c1.png",
  citationCount: 3,
  locale: "en",
};

const baseUrl = "https://openflipbook.example";
const qr =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==";

function html(): string {
  return renderToStaticMarkup(postcardLayout(node, baseUrl, qr));
}

describe("postcardLayout", () => {
  it("renders the page title verbatim", () => {
    expect(html()).toContain("The Iron Spine — how a piston turns a wheel");
  });

  it("embeds the permalink path for the node (scheme stripped for display)", () => {
    expect(html()).toContain(`/n/${node.nodeId}`);
    // The base host should appear without the https:// prefix.
    expect(html()).toContain("openflipbook.example");
    expect(html()).not.toContain("https://openflipbook.example");
  });

  it("embeds the source image so Satori can fetch it", () => {
    expect(html()).toContain(node.imageUrl);
  });

  it("embeds the QR data URL as an image", () => {
    expect(html()).toContain(qr);
  });

  it("shows the citation count when > 0", () => {
    expect(html()).toMatch(/3\s*source/i);
  });

  it("hides the citation line when count is 0", () => {
    const out = renderToStaticMarkup(
      postcardLayout({ ...node, citationCount: 0 }, baseUrl, qr),
    );
    expect(out).not.toMatch(/source/i);
  });

  it("flips text direction to rtl for RTL locales", () => {
    const out = renderToStaticMarkup(
      postcardLayout({ ...node, locale: "ar" }, baseUrl, qr),
    );
    expect(out).toMatch(/dir="rtl"/);
  });
});
