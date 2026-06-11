// Session-path exports — pure builders over already-fetched page bytes, so
// every format is unit-testable without storage. The route walks the chain
// (db.getNodeChain), fetches each page's stored JPEG (r2.getStoredBytes) and
// hands the list here. Pure-JS deps only (jszip / pdf-lib / gifenc + jpeg-js)
// — no native modules, Vercel-safe.

import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ExportPage {
  id: string;
  parent_id: string | null;
  title: string;
  query: string;
  created_at: string;
  bytes: Uint8Array;
}

/** Evenly sample at most `cap` indices from 0..n-1, always keeping the first
 * and last (a GIF of a 40-page path should still open on the root and end on
 * the exported page). */
export function sampleEvenly(n: number, cap: number): number[] {
  if (n <= 0) return [];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < cap; i++) {
    out.push(Math.round((i * (n - 1)) / (cap - 1)));
  }
  return [...new Set(out)];
}

/** ZIP: NN-title.jpg per page + graph.json (ids/titles/parents — enough to
 * rebuild the path structure elsewhere). */
export async function buildZip(pages: ExportPage[]): Promise<Uint8Array> {
  const zip = new JSZip();
  pages.forEach((p, i) => {
    const slug = p.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || p.id;
    zip.file(`pages/${String(i + 1).padStart(2, "0")}-${slug}.jpg`, p.bytes);
  });
  zip.file(
    "graph.json",
    JSON.stringify(
      {
        exported_path: pages.map((p) => ({
          id: p.id,
          parent_id: p.parent_id,
          title: p.title,
          query: p.query,
          created_at: p.created_at,
        })),
      },
      null,
      2,
    ),
  );
  return zip.generateAsync({ type: "uint8array" });
}

/** Flipbook PDF: one full-bleed page per image with a slim title strip under
 * it — the artifact the project is named after. */
export async function buildFlipbookPdf(pages: ExportPage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("openflipbook export");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const STRIP = 26;
  for (const p of pages) {
    const img = await doc.embedJpg(p.bytes);
    const page = doc.addPage([img.width, img.height + STRIP]);
    page.drawImage(img, { x: 0, y: STRIP, width: img.width, height: img.height });
    page.drawRectangle({
      x: 0,
      y: 0,
      width: img.width,
      height: STRIP,
      color: rgb(0.94, 0.92, 0.87),
    });
    const label = p.title.slice(0, 140);
    page.drawText(label, {
      x: 12,
      y: 8,
      size: 12,
      font,
      color: rgb(0.24, 0.2, 0.16),
    });
  }
  return doc.save();
}

interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Animated GIF from decoded RGBA frames (the route decodes JPEGs with
 * jpeg-js and pre-samples via sampleEvenly). ~900ms per page. */
export async function buildGif(frames: RgbaFrame[]): Promise<Uint8Array> {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const gif = GIFEncoder();
  for (const f of frames) {
    const rgba = new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    const palette = quantize(rgba, 256);
    const indexed = applyPalette(rgba, palette);
    gif.writeFrame(indexed, f.width, f.height, { palette, delay: 900 });
  }
  gif.finish();
  return gif.bytes();
}
