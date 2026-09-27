import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readServerEnv } from "@/lib/env";
import { buildWorldZip, type WorldExportNode } from "@/lib/export-build";
import { getStoredBytes } from "@/lib/r2";
import { meshSourceBytes, wireMeshSource } from "@/lib/mesh-source";
import { CreatorError } from "@/lib/creator-error";
import { snapshotWorldExport } from "@/lib/world-export-snapshot";
import { downloadPlaceViewExports } from "@/lib/place-view-server";
import { downloadMotionArchive } from "@/lib/motion-archive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Params { params: Promise<{ sessionId: string }> }
const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const BUNDLE_BYTES = 384 * 1024 * 1024;

/** One metadata snapshot, then immutable downloads. Never return a truncated
 * or missing-image success response masquerading as a whole-world export. */
export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB) return NextResponse.json({ error: "Persistence not configured" }, { status: 503, headers: privateHeaders });
  try {
    const snapshot = await snapshotWorldExport(sessionId);
    let totalBytes = 0;
    function account(bytes: Uint8Array) {
      totalBytes += bytes.length;
      if (totalBytes > BUNDLE_BYTES) throw new CreatorError("World export exceeds 384 MiB; nothing was exported", 413);
      return bytes;
    }
    async function required(key: string, label: string, expected?: { bytes: number; sha256: string }) {
      if (expected && (expected.bytes < 1 || expected.bytes > BUNDLE_BYTES - totalBytes)) throw new CreatorError("World export exceeds its asset size limit", 413);
      const stored = await getStoredBytes(key, AbortSignal.timeout(90_000));
      if (!stored || !stored.bytes.length) throw new CreatorError(`Saved ${label} is unavailable; nothing was exported`, 503);
      account(stored.bytes);
      if (expected && (stored.bytes.length !== expected.bytes || createHash("sha256").update(stored.bytes).digest("hex") !== expected.sha256)) throw new CreatorError(`Saved ${label} is corrupted; nothing was exported`, 503);
      return stored;
    }
    const nodes: WorldExportNode[] = [];
    for (const doc of snapshot.nodes) {
      const stored = await required(doc.image_key, "page image");
      const { _id, session_id: _sid, created_at, geo_extracted_at, ...metadata } = doc;
      nodes.push({ id: _id, parent_id: doc.parent_id, title: doc.page_title || doc.query, query: doc.query,
        created_at: created_at.toISOString(), relation: doc.relation ?? "descend", scale_tier: doc.scale_tier ?? null,
        click_in_parent: doc.click_in_parent, scene_view: doc.scene_view ?? null, sources: doc.sources ?? [],
        transition_context: doc.transition_context ?? null, content_type: stored.contentType, bytes: stored.bytes,
        metadata: { ...metadata, geo_extracted_at: geo_extracted_at?.toISOString() ?? null } });
    }
    const scenes = snapshot.scenes.map(({ _id: _unused, ...scene }) => scene);
    const referenceKeys = [...new Set([
      ...snapshot.worldMap.entities.flatMap(e => e.identity_anchor ? [e.identity_anchor.image_key] : []),
      ...scenes.flatMap(s => s.source_image_key ? [s.source_image_key] : []),
      ...snapshot.nodes.flatMap(n => n.transition_context?.source_image_key ? [n.transition_context.source_image_key] : []),
    ])];
    if (referenceKeys.length > 500) throw new CreatorError("World export exceeds 500 reference images; nothing was exported", 413);
    const references = [];
    for (const image_key of referenceKeys) {
      const stored = await required(image_key, "reference image");
      references.push({ image_key, bytes: stored.bytes, contentType: stored.contentType });
    }
    const packs = [];
    if (scenes.some(s => s.definition.material_pack === "ankh-street-v1")) packs.push({ id: "ankh-street-v1", bytes: account(await readFile(join(process.cwd(), "public/demos/ankh-morpork/material-atlas.png"))) });
    const meshes = []; let meshBytes = 0;
    for (const asset of snapshot.meshes) {
      meshBytes += asset.bytes;
      if (asset.image_input && snapshot.privateOwner) meshBytes += asset.image_input.bytes + asset.image_input.original.bytes;
      if (meshBytes > 200 * 1024 * 1024) throw new CreatorError("Mesh export exceeds 200 MiB", 413);
      const stored = await required(asset.key, "mesh", asset);
      let image_input;
      if (asset.image_input && snapshot.privateOwner) {
        image_input = { ...wireMeshSource(asset.image_input), bytes: account(await meshSourceBytes(asset.image_input)),
          original: { bytes: account(await meshSourceBytes(asset.image_input, true)), sha256: asset.image_input.original.sha256, content_type: asset.image_input.original.content_type } };
      }
      meshes.push({ id: asset.id, sha256: asset.sha256, model: asset.model, prompt: asset.prompt, bytes: stored.bytes,
        ...(image_input ? { image_input } : {}), ...(asset.request_id ? { request_id: asset.request_id } : {}),
        ...(asset.imported ? { imported: asset.imported } : {}), ...(asset.parameters ? { parameters: asset.parameters } : {}),
        ...(asset.dependency ? { dependency: asset.dependency } : {}), created_at: new Date(asset.created_at).toISOString() });
    }
    const materials = []; let materialBytes = 0;
    for (const asset of snapshot.materials) {
      if (!asset.request_id) throw new CreatorError("Material provider provenance is missing", 503);
      materialBytes += asset.bytes;
      if (materialBytes > 64 * 1024 * 1024) throw new CreatorError("Material export exceeds 64 MiB", 413);
      const stored = await required(asset.key, "material", asset);
      materials.push({ id: asset.id, sha256: asset.sha256, prompt: asset.prompt, model: asset.model, request_id: asset.request_id,
        ...(asset.parameters ? { parameters: asset.parameters } : {}), ...(asset.image ? { image: asset.image } : {}),
        ...(asset.dependency ? { dependency: asset.dependency } : {}), created_at: new Date(asset.created_at).toISOString(), bytes: stored.bytes });
    }
    const views = await downloadPlaceViewExports(snapshot.views);
    for (const view of views) { for (const pass of view.passes) account(pass.bytes); for (const illustration of view.illustrations ?? []) account(illustration.bytes); }
    const motion = await downloadMotionArchive(snapshot.motion, required);
    const bytes = await buildWorldZip(nodes, snapshot.worldMap, snapshot.entities, references, scenes, packs,
      snapshot.artwork, meshes, snapshot.connections, materials, views, {
        session_id: sessionId, captured_at: snapshot.captured_at, visibility: snapshot.privateOwner ? "owner" : "shared",
        scene_heads: snapshot.sceneHeads.map(({ _id: _unused, ...s }) => s), entity_registry: snapshot.registry, workspace: snapshot.workspace,
        external_resources: snapshot.nodes.flatMap(n => n.descent_video_url ? [{ kind: "arrival_video", node_id: n._id, url: n.descent_video_url }] : []),
      }, motion);
    return new Response(Buffer.from(bytes), { headers: { ...privateHeaders, "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="openflipbook-world-${sessionId.slice(0, 8)}.zip"` } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof CreatorError ? e.message : "World export unavailable. No archive was created; try again." }, { status: e instanceof CreatorError ? e.status : 503, headers: privateHeaders });
  }
}
