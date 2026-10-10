import { Matrix4, OrthographicCamera, PerspectiveCamera, Plane, Ray, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { projectSourceArtwork, type SourceArtworkProjectionInput, type SourceSurfaceBinding } from "./source-art-projection";

const SHA = "a".repeat(64), WIDTH = 8, HEIGHT = 8;
const identity = new Matrix4().toArray();
const quad = [[-2, -2, -5], [2, -2, -5], [2, 2, -5], [-2, 2, -5]] as const;
const binding: SourceSurfaceBinding = { surface_id: "bookshop-front", object_id: "bookshop", source_sha256: SHA,
  object_world_matrix: identity, object_local_quad: quad, source_pixel_quad: [[0, HEIGHT], [WIDTH, HEIGHT], [WIDTH, 0], [0, 0]] };

function source(width = WIDTH, height = HEIGHT) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([x * 3, y * 3, (x + y) * 2, 255], (y * width + x) * 4);
  return { sha256: SHA, width, height, rgba };
}
function fixture(): SourceArtworkProjectionInput {
  const camera = new OrthographicCamera(-2, 2, 2, -2, .1, 20); camera.updateMatrixWorld();
  const render = new Uint8Array(WIDTH * HEIGHT * 4), depth = new Uint8Array(render.length);
  for (let p = 0; p < WIDTH * HEIGHT; p++) { render.set([17, 43, p, 77], p * 4); depth.set([142, 142, 142, 255], p * 4); }
  return { source: source(), bindings: [binding], target: { render, depth, objects: new Int32Array(WIDTH * HEIGHT), object_ids: ["bookshop", "forge"],
    view: { width: WIDTH, height: HEIGHT, depth: { near: 1, far: 10 }, camera: { projection: "orthographic", near: .1, far: 20,
      world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray() } } } };
}

describe("projectSourceArtwork", () => {
  it("copies original pixels exactly through a registered frontal plane and keeps every input immutable", () => {
    const input = fixture(), renderBefore = input.target.render.slice(), depthBefore = input.target.depth.slice(), sourceBefore = input.source.rgba.slice();
    const output = projectSourceArtwork(input);
    expect(output.rgba).toEqual(input.source.rgba);
    expect([...output.source_pixel_indices]).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(output.projected.every(v => v === 1)).toBe(true);
    expect(output.holes.every(v => v === 0)).toBe(true);
    expect(output.proof.objects[0]).toMatchObject({ object_id: "bookshop", visible_pixels: 64, projected_pixels: 64, unsupported_pixels: 0, supported_coverage: 1 });
    expect(output.proof).toMatchObject({ source_sha256: SHA, sampling: "nearest_original_pixel", projected_pixels: 64, changed_protected_pixels: 0 });
    expect(input.target.render).toEqual(renderBefore); expect(input.target.depth).toEqual(depthBefore); expect(input.source.rgba).toEqual(sourceBefore);
  });

  it("samples the same source surface under translated, turned and closer perspective cameras", () => {
    const objectWorld = new Matrix4().makeTranslation(.3, -.2, -6).multiply(new Matrix4().makeRotationY(.18));
    const inverse = objectWorld.clone().invert(), worldNormal = new Vector3(0, 0, 1).transformDirection(objectWorld);
    const plane = new Plane().setFromNormalAndCoplanarPoint(worldNormal, new Vector3().setFromMatrixPosition(objectWorld));
    const width = 40, height = 32, original = source(64, 64);
    let total = 0;
    for (const [x, y, z, yaw] of [[0, 0, 0, 0], [.8, .2, 1, .13]] as const) {
      const camera = new PerspectiveCamera(60, width / height, .1, 30);
      camera.position.set(x, y, z); camera.rotation.y = yaw!; camera.updateMatrixWorld();
      const render = new Uint8Array(width * height * 4).fill(53), depth = new Uint8Array(render.length);
      const normals = new Uint8Array(render.length), objects = new Int32Array(width * height).fill(-1), expected = new Int32Array(width * height).fill(-1);
      const viewNormal = worldNormal.clone().transformDirection(camera.matrixWorldInverse);
      for (let p = 0; p < width * height; p++) {
        const ray = new Ray(camera.position.clone(), new Vector3((p % width + .5) / width * 2 - 1,
          1 - (Math.floor(p / width) + .5) / height * 2, .5).unproject(camera).sub(camera.position).normalize());
        const hit = ray.intersectPlane(plane, new Vector3()); if (!hit) continue;
        const local = hit.clone().applyMatrix4(inverse);
        if (Math.abs(local.x) >= 2 || Math.abs(local.y) >= 2) continue;
        objects[p] = 0;
        const d = -hit.clone().applyMatrix4(camera.matrixWorldInverse).z, byte = Math.round(255 * (1 - (d - 1) / 19));
        depth.set([byte, byte, byte, 255], p * 4);
        normals.set([Math.round((viewNormal.x + 1) * 127.5), Math.round((viewNormal.y + 1) * 127.5), Math.round((viewNormal.z + 1) * 127.5), 255], p * 4);
        expected[p] = Math.floor((2 - local.y) * 16) * 64 + Math.floor((local.x + 2) * 16);
      }
      const output = projectSourceArtwork({ source: original, bindings: [{ ...binding, object_world_matrix: objectWorld.toArray(),
        object_local_quad: [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]], source_pixel_quad: [[0, 64], [64, 64], [64, 0], [0, 0]] }],
        target: { render, depth, normals, objects, object_ids: ["bookshop"], view: { width, height, depth: { near: 1, far: 20 },
          camera: { projection: "perspective", world_matrix: camera.matrixWorld.toArray(), projection_matrix: camera.projectionMatrix.toArray(), near: .1, far: 30 } } } });
      expect(output.source_pixel_indices).toEqual(expected);
      for (let p = 0; p < expected.length; p++) if (expected[p]! >= 0) {
        expect(output.rgba.subarray(p * 4, p * 4 + 4)).toEqual(original.rgba.subarray(expected[p]! * 4, expected[p]! * 4 + 4)); total++;
      }
      expect(output.proof.objects[0]!.supported_coverage).toBe(1);
    }
    expect(total).toBeGreaterThan(500);
  });

  it("uses a projective source quad rather than resizing its bounding rectangle", () => {
    const input = fixture(); input.bindings = [{ ...binding, source_pixel_quad: [[0, 8], [8, 8], [6, 0], [2, 0]] }];
    const output = projectSourceArtwork(input);
    // At the top, the source narrows to x2..6; the bottom remains x0..8.
    expect(output.source_pixel_indices[0]! % 8).toBe(2);
    expect(output.source_pixel_indices[7]! % 8).toBe(5);
    expect(output.source_pixel_indices[56]! % 8).toBe(0);
    expect(output.source_pixel_indices[63]! % 8).toBe(7);
    expect(output.proof.objects[0]!.supported_coverage).toBe(1);
  });

  it("protects unbound objects and background RGBA byte for byte, including alpha", () => {
    const input = fixture();
    input.target.objects[0] = 1; input.target.objects[1] = -1;
    const output = projectSourceArtwork(input);
    expect(output.rgba.subarray(0, 8)).toEqual(input.target.render.subarray(0, 8));
    expect([...output.projected.subarray(0, 2)]).toEqual([0, 0]);
    expect([...output.holes.subarray(0, 2)]).toEqual([0, 0]);
    expect(output.proof).toMatchObject({ protected_pixels: 2, changed_protected_pixels: 0 });
    expect(output.proof.objects[0]!.visible_pixels).toBe(62);
  });

  it("does not paint a same-object occluder or a face whose saved normal disagrees", () => {
    const input = fixture(); input.target.depth.set([170, 170, 170, 255], 0);
    input.target.normals = new Uint8Array(64 * 4);
    for (let p = 0; p < 64; p++) input.target.normals.set([128, 128, 255, 255], p * 4);
    input.target.normals.set([255, 128, 128, 255], 4);
    const output = projectSourceArtwork(input);
    expect(output.rgba.subarray(0, 8)).toEqual(input.target.render.subarray(0, 8));
    expect([...output.holes.subarray(0, 2)]).toEqual([1, 1]);
    expect(output.proof.objects[0]!.holes).toMatchObject({ depth_mismatch: 1, normal_mismatch: 1 });
    expect(output.proof.depth_tolerance_m).toBeCloseTo(9 / 510 + 1e-5, 10);
  });

  it("reports missing geometry, excluded original labels and transparent source as holes without fill", () => {
    const input = fixture(); input.target.depth.fill(0, 0, 4);
    input.source.valid_mask = new Uint8Array(64).fill(1); input.source.valid_mask[1] = 0;
    input.source.rgba[2 * 4 + 3] = 100;
    const output = projectSourceArtwork(input);
    expect(output.rgba.subarray(0, 12)).toEqual(input.target.render.subarray(0, 12));
    expect([...output.source_pixel_indices.subarray(0, 3)]).toEqual([-1, -1, -1]);
    expect(output.proof.objects[0]).toMatchObject({ unsupported_pixels: 3, holes: { missing_depth: 1, source_invalid: 2 } });
  });

  it("leaves unsupported surface regions and back faces untouched", () => {
    const input = fixture(); input.bindings = [{ ...binding, object_local_quad: [[-1, -1, -5], [1, -1, -5], [1, 1, -5], [-1, 1, -5]] }];
    const output = projectSourceArtwork(input);
    expect(output.proof.objects[0]).toMatchObject({ projected_pixels: 16, unsupported_pixels: 48, holes: { no_surface: 48 } });
    input.bindings = [{ ...binding, object_local_quad: [quad[3], quad[2], quad[1], quad[0]] }];
    const back = projectSourceArtwork(input);
    expect(back.rgba).toEqual(input.target.render); expect(back.proof.objects[0]!.holes.no_surface).toBe(64);
  });

  it("fails closed on overlapping surface bindings rather than depending on their order", () => {
    const input = fixture(); input.bindings = [binding, { ...binding, surface_id: "overlap" }];
    const output = projectSourceArtwork(input);
    expect(output.rgba).toEqual(input.target.render);
    expect(output.proof.objects[0]!.holes.ambiguous_surface).toBe(64);
    expect(output.surface_indices.every(i => i === -1)).toBe(true);
  });

  it.each([
    ["source SHA", (input: SourceArtworkProjectionInput) => { input.bindings = [{ ...binding, source_sha256: "b".repeat(64) }]; }],
    ["planar", (input: SourceArtworkProjectionInput) => { input.bindings = [{ ...binding, object_local_quad: [quad[0], quad[1], [2, 2, -4], quad[3]] }]; }],
    ["convex", (input: SourceArtworkProjectionInput) => { input.bindings = [{ ...binding, source_pixel_quad: [[0, 8], [8, 0], [8, 8], [0, 0]] }]; }],
    ["outside", (input: SourceArtworkProjectionInput) => { input.bindings = [{ ...binding, source_pixel_quad: [[0, 8], [9, 8], [8, 0], [0, 0]] }]; }],
    ["rigid", (input: SourceArtworkProjectionInput) => { input.bindings = [{ ...binding, object_world_matrix: new Matrix4().makeScale(2, 1, 1).toArray() }]; }],
    ["unknown object", (input: SourceArtworkProjectionInput) => { input.target.objects[0] = 7; }],
    ["unique", (input: SourceArtworkProjectionInput) => { input.bindings = [binding, binding]; }],
    ["binary", (input: SourceArtworkProjectionInput) => { input.source.valid_mask = new Uint8Array(64).fill(2); }],
    ["registered RGBA", (input: SourceArtworkProjectionInput) => { input.target.depth = new Uint8Array(4); }],
  ] as const)("rejects invalid %s before changing pixels", (message, mutate) => {
    const input = fixture(), renderBefore = input.target.render.slice(); mutate(input);
    expect(() => projectSourceArtwork(input)).toThrow(message); expect(input.target.render).toEqual(renderBefore);
  });
});
