import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  buildFlipbookPdf,
  buildGif,
  buildZip,
  sampleEvenly,
  type ExportPage,
} from "./export-build";

// A minimal valid JPEG (1x1, generated once with jpeg-js) — enough for the
// zip entries; the PDF test needs real JPEG structure, which this is.
async function tinyJpeg(): Promise<Uint8Array> {
  const { encode } = await import("jpeg-js");
  const data = new Uint8Array([200, 180, 150, 255]);
  return new Uint8Array(
    encode({ data, width: 1, height: 1 }, 90).data,
  );
}

function page(id: string, bytes: Uint8Array, parent: string | null): ExportPage {
  return {
    id,
    parent_id: parent,
    title: `Page ${id}`,
    query: `query ${id}`,
    created_at: "2026-06-11T00:00:00Z",
    bytes,
  };
}

describe("sampleEvenly", () => {
  it("identity under the cap; first+last kept over it", () => {
    expect(sampleEvenly(3, 16)).toEqual([0, 1, 2]);
    const sampled = sampleEvenly(40, 16);
    expect(sampled.length).toBeLessThanOrEqual(16);
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(39);
    expect(sampleEvenly(0, 16)).toEqual([]);
  });
});

describe("buildZip", () => {
  it("one entry per page + a graph.json that rebuilds the path", async () => {
    const jpg = await tinyJpeg();
    const bytes = await buildZip([page("a", jpg, null), page("b", jpg, "a")]);
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    expect(names.filter((n) => n.endsWith(".jpg"))).toHaveLength(2);
    const graph = JSON.parse(await zip.file("graph.json")!.async("string"));
    expect(graph.exported_path).toHaveLength(2);
    expect(graph.exported_path[1].parent_id).toBe("a");
  });
});

describe("buildFlipbookPdf", () => {
  it("a real PDF with one page per image", async () => {
    const jpg = await tinyJpeg();
    const bytes = await buildFlipbookPdf([
      page("a", jpg, null),
      page("b", jpg, "a"),
      page("c", jpg, "b"),
    ]);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
  });
});

describe("buildGif", () => {
  it("an animated GIF89a from RGBA frames", async () => {
    const frame = {
      width: 4,
      height: 4,
      data: new Uint8Array(4 * 4 * 4).fill(180),
    };
    const bytes = await buildGif([frame, frame]);
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe("GIF89a");
  });
});
