// Session-path exports — pure builders over already-fetched page bytes, so
// every format is unit-testable without storage. The route walks the chain
// (db.getNodeChain), fetches each page's stored JPEG (r2.getStoredBytes) and
// hands the list here. Pure-JS deps only (jszip / pdf-lib / gifenc + jpeg-js)
// — no native modules, Vercel-safe.

import JSZip from "jszip";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PlaceViewExport } from "./place-view";
import type { MotionArchiveExport } from "./motion-archive";
import type { MeshSource, MeshImportProvenance } from "./mesh-asset";
export interface MeshSourceExport extends MeshSource {
  bytes: Uint8Array;
  original: { bytes: Uint8Array; sha256: string; content_type: string };
}

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

/** A node in the whole-session ("world") export: the full page metadata plus
 * its bytes (null when the blob is missing — the node still appears in the
 * graph, just without an image file). Decoupled from the db NodeRow so the
 * builder stays pure. */
export interface WorldExportNode {
  metadata?: Record<string, unknown>;
  content_type?: string;
  transition_context?: unknown;
  id: string;
  parent_id: string | null;
  title: string;
  query: string;
  created_at: string;
  relation: string;
  scale_tier: string | null;
  click_in_parent: unknown;
  scene_view: unknown;
  sources: unknown[];
  bytes: Uint8Array | null;
}

export interface WorldExportContext {
  session_id: string;
  captured_at: string;
  visibility: "owner" | "shared";
  scene_heads: unknown[];
  entity_registry: unknown;
  workspace: unknown;
  external_resources: { kind: string; url: string; node_id?: string }[];
}

/** The whole-world bundle: every branch's image + a rich graph.json (topology,
 * click provenance, per-node observer pose) + the geometric world-map.json and
 * the entities.json registry. This content bundle is not a database backup;
 * private content import is separate from full backup/operator recovery. */
export async function buildWorldZip(
  nodes: WorldExportNode[],
  worldMap: unknown,
  entities: unknown,
  references: { image_key: string; bytes: Uint8Array | null; contentType: string }[] = [],
  placeScenes: unknown[] = [],
  materialPacks: { id: string; bytes: Uint8Array }[] = [],
  mapArtwork: { heads: unknown[]; versions: unknown[]; drafts?:unknown[] } = { heads: [], versions: [] },
  meshes: { id: string; sha256: string; model: string; prompt: string; bytes: Uint8Array | null; request_id?: string; parameters?: Record<string, unknown>; dependency?: unknown; created_at?: string; image_input?: MeshSourceExport; imported?: MeshImportProvenance }[] = [],
  connections: unknown[] = [],
  surfaceMaterials: { id: string; sha256: string; prompt: string; model: string; request_id: string; parameters?: Record<string, unknown>; image?: unknown; dependency?: unknown; created_at: string; bytes: Uint8Array }[] = [],
  cameraViews: PlaceViewExport[] = [],
  context?: WorldExportContext,
  motion?: MotionArchiveExport,
): Promise<Uint8Array> {
  const zip = new JSZip();
  const hasMotion = Boolean(motion && (motion.studies.length || motion.assets.length || motion.reviews.length || motion.selections.length));
  const hasAlignment=Boolean(mapArtwork.drafts?.length), archiveVersion=hasAlignment?3:hasMotion?2:1;
  if (hasMotion || hasAlignment) {
    if (context?.visibility !== "owner") throw new Error("Motion archives require owner visibility");
    const { files, ...metadata } = motion ?? {files:[],studies:[],assets:[],reviews:[],selections:[]};
    zip.file("motion.json", JSON.stringify({ version: 1, ...metadata, files: files.map(({ data, ...file }) => {
      zip.file(file.file, data); return file;
    }) }, null, 2));
  }
  const graph = nodes.map((n, i) => {
    let image: string | null = null;
    if (n.bytes) {
      const slug = n.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || n.id;
      const ext = n.content_type === "image/png" ? "png" : n.content_type === "image/webp" ? "webp" : "jpg";
      image = `pages/${String(i + 1).padStart(3, "0")}-${slug}.${ext}`;
      zip.file(image, n.bytes);
    }
    return {
      ...n.metadata,
      id: n.id,
      parent_id: n.parent_id,
      title: n.title,
      query: n.query,
      created_at: n.created_at,
      relation: n.relation,
      scale_tier: n.scale_tier,
      click_in_parent: n.click_in_parent,
      scene_view: n.scene_view,
      transition_context: n.transition_context ?? null,
      sources: n.sources,
      image,
    };
  });
  zip.file("graph.json", JSON.stringify({ nodes: graph }, null, 2));
  zip.file("world-map.json", JSON.stringify(worldMap ?? null, null, 2));
  zip.file("place-scenes.json", JSON.stringify(placeScenes, null, 2));
  zip.file("place-connections.json", JSON.stringify(connections, null, 2));
  zip.file("place-views.json", JSON.stringify(cameraViews.map(({ view, capture_metadata, passes, illustrations }, index) => ({ ...view,
    ...(capture_metadata ? { capture_metadata } : {}),
    passes: passes.map(({ pass, bytes, sha256 }) => {
      const file = `views/${index + 1}/${pass}.png`; zip.file(file, bytes);
      return { pass, file, sha256, bytes: bytes.length };
    }),
    ...(illustrations?.length ? { illustrations: illustrations.map(({ asset, bytes }, imageIndex) => {
      const file = `views/${index + 1}/illustrations/${imageIndex + 1}.${asset.content_type === "image/png" ? "png" : "jpg"}`; zip.file(file, bytes);
      return { ...asset, file, bytes: bytes.length };
    }) } : {}),
  })), null, 2));
  zip.file("map-artwork.json", JSON.stringify(mapArtwork, null, 2));
  zip.file("mesh-assets.json", JSON.stringify(meshes.map((mesh, index) => {
    const file = mesh.bytes ? `meshes/${index + 1}.glb` : null;
    if (file && mesh.bytes) zip.file(file, mesh.bytes);
    let image_input;
    if (mesh.image_input) {
      const { bytes, original, ...source } = mesh.image_input;
      const inputFile = `meshes/inputs/${source.id}/input.png`, originalFile = `meshes/inputs/${source.id}/original.${original.content_type.split("/")[1]}`;
      zip.file(inputFile, bytes); zip.file(originalFile, original.bytes);
      image_input = { ...source, file: inputFile, bytes: bytes.length,
        original: { file: originalFile, sha256: original.sha256, bytes: original.bytes.length, content_type: original.content_type } };
    }
    return {id: mesh.id, sha256: mesh.sha256, model: mesh.model, prompt: mesh.prompt, file, missing: !mesh.bytes,
      ...(image_input ? { image_input } : {}), ...(mesh.imported ? { imported: mesh.imported } : {}), ...(mesh.request_id ? {request_id: mesh.request_id} : {}), ...(mesh.parameters ? {parameters: mesh.parameters} : {}), ...(mesh.dependency ? {dependency: mesh.dependency} : {}), ...(mesh.created_at ? {created_at: mesh.created_at} : {})};
  }), null, 2));
  const packs = materialPacks.map((pack, index) => {
    const image = `materials/${index + 1}-atlas.png`;
    zip.file(image, pack.bytes);
    return { id: pack.id, image, quadrants: ["stone", "plaster", "roof", "wood"], mapping: "object-space UVs; see street-materials.ts" };
  });
  zip.file("material-packs.json", JSON.stringify(packs, null, 2));
  zip.file("surface-materials.json", JSON.stringify(surfaceMaterials.map(({ bytes, ...asset }, index) => {
    const file = `materials/${index + 1}-base-color.jpg`; zip.file(file, bytes);
    return { ...asset, file };
  }), null, 2));
  zip.file("entities.json", JSON.stringify(entities ?? null, null, 2));
  const referenceFiles = references.map((ref, i) => {
    const ext = ref.contentType === "image/png" ? "png" : ref.contentType === "image/webp" ? "webp" : "jpg";
    const image = ref.bytes ? `references/${String(i + 1).padStart(3, "0")}.${ext}` : null;
    if (image && ref.bytes) zip.file(image, ref.bytes);
    return { image_key: ref.image_key, image };
  });
  zip.file("references.json", JSON.stringify(referenceFiles, null, 2));
  if (context) {
    zip.file("place-scene-heads.json", JSON.stringify(context.scene_heads, null, 2));
    if (context.visibility === "owner") {
      zip.file("entity-registry.json", JSON.stringify(context.entity_registry, null, 2));
      zip.file("workspace.json", JSON.stringify(context.workspace, null, 2));
    }
  }
  const files = [];
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.files[name]!;
    if (file.dir) continue;
    const bytes = await file.async("uint8array");
    files.push({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  zip.file("manifest.json", JSON.stringify({
    format: "openflipbook-world-content", version: archiveVersion,
    session_id: context?.session_id ?? null, captured_at: context?.captured_at ?? null,
    metadata_consistency: context ? "database_snapshot" : "caller_supplied",
    visibility: context?.visibility ?? "unspecified",
    missing_files: [...nodes.filter(n => !n.bytes).map(n => ({ kind: "node", id: n.id })),
      ...references.filter(r => !r.bytes).map(r => ({ kind: "reference", id: r.image_key })),
      ...meshes.filter(m => !m.bytes).map(m => ({ kind: "mesh", id: m.id }))],
    external_resources: context?.external_resources ?? [],
    // Checksums verify this content bundle, not a portable database backup.
    // Import validation and private draft/job recovery are separate work.
    restore_supported: false,
    content_import_version: context?.visibility === "owner" ? archiveVersion : null,
    excludes: ["owner_credentials", "private_notes", "active_jobs", "spend_reservations", "unbound_concept_drafts"],
    files,
  }, null, 2));
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
