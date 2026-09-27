import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  buildFlipbookPdf,
  buildGif,
  buildWorldZip,
  buildZip,
  sampleEvenly,
  type ExportPage,
  type WorldExportNode,
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
  it("exports imported mesh provenance without inventing a provider receipt", async () => {
    const imported = { kind: "imported_mesh" as const, filename: "Tower.glb", validator_version: "2.0.0-dev.3.10", warnings: [] };
    const bytes = new Uint8Array([1, 2, 3]);
    const zip = await JSZip.loadAsync(await buildWorldZip([], null, null, [], [], [], { heads: [], versions: [] }, [{ id: "import_hash", sha256: "hash", model: "imported/glb", prompt: "Tower.glb", bytes, imported }]));
    const asset = JSON.parse(await zip.file("mesh-assets.json")!.async("string"))[0]; expect(asset.imported).toEqual(imported); expect(asset).not.toHaveProperty("request_id"); expect(await zip.file(asset.file)!.async("uint8array")).toEqual(bytes);
  });
  it("bundles original and exact image-to-mesh inputs with portable provenance", async () => {
    const source = { id: "concept", label: "Tower concept", sha256: "normalized-hash", width: 64, height: 96, origin: { kind: "imported_reference" as const }, bytes: new Uint8Array([2, 3]), original: { bytes: new Uint8Array([4, 5]), sha256: "original-hash", content_type: "image/jpeg" } };
    const zip = await JSZip.loadAsync(await buildWorldZip([], null, null, [], [], [], { heads: [], versions: [] }, [{ id: "mesh", sha256: "mesh-hash", model: "image-model", prompt: "Name only", bytes: new Uint8Array([1]), image_input: source }]));
    const input = JSON.parse(await zip.file("mesh-assets.json")!.async("string"))[0].image_input;
    expect(input).toMatchObject({ id: "concept", origin: source.origin, sha256: source.sha256, original: { sha256: source.original.sha256 } });
    expect(await zip.file(input.file)!.async("uint8array")).toEqual(source.bytes);
    expect(await zip.file(input.original.file)!.async("uint8array")).toEqual(source.original.bytes);
    expect(input).not.toHaveProperty("key");
  });
  it("includes immutable place definitions and their source bytes in world bundles", async () => {
    const scenes = [{ id: "scene", revision: 2, source_image_key: "source.png", definition: { material_pack: "ankh-street-v1", objects: [{ id: "tavern", entity_id: "entity_tavern", eave_height: 6.2, roof_offset: 2, roof_material: "teal" }] } }];
    const zip = await JSZip.loadAsync(await buildWorldZip([], null, null, [{ image_key: "source.png", bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }], scenes, [{ id: "ankh-street-v1", bytes: new Uint8Array([4, 5, 6]) }]));
    expect(JSON.parse(await zip.file("place-scenes.json")!.async("string"))).toEqual(scenes);
    expect(await zip.file("references/001.png")!.async("uint8array")).toEqual(new Uint8Array([1, 2, 3]));
    expect(JSON.parse(await zip.file("material-packs.json")!.async("string"))[0]).toMatchObject({ id: "ankh-street-v1", image: "materials/1-atlas.png" });
    expect(await zip.file("materials/1-atlas.png")!.async("uint8array")).toEqual(new Uint8Array([4, 5, 6]));
  });
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

function worldNode(
  id: string,
  bytes: Uint8Array | null,
  parent: string | null,
  extra: Partial<WorldExportNode> = {},
): WorldExportNode {
  return {
    id,
    parent_id: parent,
    title: `Page ${id}`,
    query: `q ${id}`,
    created_at: "2026-06-11T00:00:00Z",
    relation: "descend",
    scale_tier: null,
    click_in_parent: null,
    scene_view: null,
    sources: [],
    bytes,
    ...extra,
  };
}

describe("buildWorldZip", () => {
  it("labels missing legacy content and does not claim it is restorable", async () => {
    const zip = await JSZip.loadAsync(await buildWorldZip([worldNode("missing", null, null)], null, null));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest).toMatchObject({ version: 1, metadata_consistency: "caller_supplied", restore_supported: false, missing_files: [{ kind: "node", id: "missing" }] });
    expect(manifest.files.every((f: { sha256: string; bytes: number }) => /^[a-f0-9]{64}$/.test(f.sha256) && f.bytes > 0)).toBe(true);
  });
  it("bundles mesh bytes and provenance with stable asset ids", async () => {
    const bytes=new Uint8Array([1,2,3]);
    const zip=await JSZip.loadAsync(await buildWorldZip([],null,null,[],[],[],undefined,[{id:"mesh_one",sha256:"digest",model:"provider-model",prompt:"A bakery",bytes}]));
    expect(await zip.file("meshes/1.glb")!.async("uint8array")).toEqual(bytes);
    expect(JSON.parse(await zip.file("mesh-assets.json")!.async("string"))).toEqual([{id:"mesh_one",sha256:"digest",model:"provider-model",prompt:"A bakery",file:"meshes/1.glb",missing:false}]);
  });
  it("retains build-bound mesh dependency provenance in the portable manifest", async () => {
    const dependency = { kind: "mesh", place_id: "district", revision: 2, input_sha256: "source", build_key: "world:district:build", result_sha256: "layout", plan_sha256: "meshes" };
    const mesh = { id: "mesh_built", sha256: "digest", model: "provider-model", prompt: "A monument", bytes: new Uint8Array([4, 5, 6]), request_id: "provider-request", parameters: { textured: true }, dependency };
    const zip = await JSZip.loadAsync(await buildWorldZip([], null, null, [], [], [], undefined, [mesh]));
    const manifest = JSON.parse(await zip.file("mesh-assets.json")!.async("string"));
    expect(manifest).toEqual([{ id: mesh.id, sha256: mesh.sha256, model: mesh.model, prompt: mesh.prompt, request_id: mesh.request_id, parameters: mesh.parameters, dependency, file: "meshes/1.glb", missing: false }]);
    expect(await zip.file(manifest[0].file)!.async("uint8array")).toEqual(mesh.bytes);
  });
  it("exports map artwork heads and geometry-bound provenance", async () => {
    const artwork = { heads: [{ node_id: "painted", map_root_node_id: "map" }], versions: [{ node_id: "painted", scene_revision: 3, registration: { x: 45, y: 60, width: 10, rotation: 0 } }] };
    const zip = await JSZip.loadAsync(await buildWorldZip([], null, null, [], [], [], artwork));
    expect(JSON.parse(await zip.file("map-artwork.json")!.async("string"))).toEqual(artwork);
  });
  it("preserves the immutable transition binding in the exported graph", async () => {
    const transition = {
      version: 1 as const, source_node_id: "a", source_image_key: "original.jpg",
      target_point: { x_pct: 0.9, y_pct: 0.2 }, target_geo_id: null,
      target_bbox: null, target_provenance: "tap" as const,
      source_view: null, destination_view: null,
    };
    const zip = await JSZip.loadAsync(await buildWorldZip([
      worldNode("b", null, "a", { transition_context: transition }),
    ], {}, {}));
    const graph = JSON.parse(await zip.file("graph.json")!.async("string"));
    expect(graph.nodes[0].transition_context).toEqual(transition);
  });
  it("bundles immutable references separately from later page revisions", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const zip = await JSZip.loadAsync(await buildWorldZip([], {}, {}, [
      { image_key: "original.png", bytes: original, contentType: "image/png" },
      { image_key: "missing.jpg", bytes: null, contentType: "image/jpeg" },
    ]));
    const refs = JSON.parse(await zip.file("references.json")!.async("string"));
    expect(refs).toEqual([{ image_key: "original.png", image: "references/001.png" }, { image_key: "missing.jpg", image: null }]);
    expect(await zip.file(refs[0].image)!.async("uint8array")).toEqual(original);
  });
  it("bundles every node's image + a rich graph, world-map, and entities json", async () => {
    const jpg = await tinyJpeg();
    const bytes = await buildWorldZip(
      [
        worldNode("a", jpg, null, { scale_tier: "city" }),
        worldNode("b", jpg, "a", {
          relation: "expand",
          click_in_parent: { x_pct: 0.5, y_pct: 0.5 },
        }),
        worldNode("c", null, "b"), // missing blob → stays in the graph, no image file
      ],
      { entities: [{ id: "geo_a" }], bounds: { x: 0, y: 0, w: 10, h: 10 } },
      { entities: [{ id: "e1", name: "Mira" }] },
    );
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    // Two images (c has no bytes) + the three JSON files.
    expect(names.filter((n) => n.endsWith(".jpg"))).toHaveLength(2);

    const graph = JSON.parse(await zip.file("graph.json")!.async("string"));
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes[1]).toMatchObject({
      id: "b",
      parent_id: "a",
      relation: "expand",
      click_in_parent: { x_pct: 0.5, y_pct: 0.5 },
    });
    expect(graph.nodes[1].image).toMatch(/^pages\/002-/);
    expect(graph.nodes[2].image).toBeNull();

    const worldMap = JSON.parse(await zip.file("world-map.json")!.async("string"));
    expect(worldMap.entities[0].id).toBe("geo_a");
    const entities = JSON.parse(await zip.file("entities.json")!.async("string"));
    expect(entities.entities[0].name).toBe("Mira");
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
