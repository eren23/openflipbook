/** Optional, deterministic source-pixel projection. This does not generate paint,
 * reconstruct unseen surfaces, change geometry, or certify an illustration gate.
 * The caller verifies the encoded original image's SHA before decoding it. */
import { Matrix4, Plane, Ray, Vector3 } from "three";
import type { KeyframeView } from "./illustration-keyframe";

export type SourcePoint2 = readonly [number, number];
export type SourcePoint3 = readonly [number, number, number];
export type SourceQuad2 = readonly [SourcePoint2, SourcePoint2, SourcePoint2, SourcePoint2];
export type SourceQuad3 = readonly [SourcePoint3, SourcePoint3, SourcePoint3, SourcePoint3];

export interface SourceSurfaceBinding {
  surface_id: string;
  object_id: string;
  source_sha256: string;
  /** Rigid, column-major authored object-local → world matrix. */
  object_world_matrix: readonly number[];
  /** Convex planar perimeter, counterclockwise when viewed from the outward side. */
  object_local_quad: SourceQuad3;
  /** Matching perimeter in original top-left pixel-edge coordinates (not normalized). */
  source_pixel_quad: SourceQuad2;
}

export interface SourceArtworkProjectionInput {
  source: {
    /** SHA of the original encoded source, checked by the caller before decoding. */
    sha256: string; width: number; height: number; rgba: Uint8Array;
    /** 1 on usable original pixels; 0 excludes labels, occlusion or uncertain source pixels. */
    valid_mask?: Uint8Array;
  };
  target: {
    view: KeyframeView; render: Uint8Array; depth: Uint8Array;
    /** Exact immutable opaque object pass, decoded to indices (-1 means background). */
    objects: Int32Array; object_ids: readonly string[];
    /** Optional saved view-space RGB normal pass, for rejecting other faces of the same object. */
    normals?: Uint8Array;
  };
  bindings: readonly SourceSurfaceBinding[];
}

export type SourceProjectionHoleReason = "missing_depth" | "no_surface" | "depth_mismatch" |
  "normal_mismatch" | "source_invalid" | "ambiguous_surface";
export interface SourceProjectionCoverage {
  object_id: string; visible_pixels: number; projected_pixels: number;
  unsupported_pixels: number; supported_coverage: number;
  holes: Record<SourceProjectionHoleReason, number>;
}
export interface SourceArtworkProjection {
  /** Original target bytes everywhere except supported, exactly masked source samples. */
  rgba: Uint8Array;
  projected: Uint8Array;
  /** Unsupported visible pixels of objects with bindings. Unbound objects are protected. */
  holes: Uint8Array;
  /** Original source pixel index, or -1; samples are copied without interpolation. */
  source_pixel_indices: Int32Array;
  /** Index into input.bindings, or -1. */
  surface_indices: Int32Array;
  proof: {
    version: "source-art-surface-projection-v1";
    source_sha256: string;
    source_hash_verification: "binding_match_only_encoded_source_verification_required";
    sampling: "nearest_original_pixel";
    depth_tolerance_m: number;
    normal_min_cosine: number | null;
    projected_pixels: number;
    protected_pixels: number;
    changed_protected_pixels: 0;
    objects: SourceProjectionCoverage[];
    surfaces: SourceSurfaceBinding[];
  };
}

const EPS = 1e-7;
const NORMAL_MIN_COSINE = .995;
const reasons: SourceProjectionHoleReason[] = ["missing_depth", "no_surface", "depth_mismatch",
  "normal_mismatch", "source_invalid", "ambiguous_surface"];
const finite = (values: readonly number[]) => values.every(Number.isFinite);
const dimensions = (width: number, height: number, name: string) => {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 4096))
    throw new Error(`${name} dimensions must be integers between 1 and 4096`);
};
const pixels = (bytes: Uint8Array, width: number, height: number, name: string) => {
  if (bytes.length !== width * height * 4) throw new Error(`${name} must be registered RGBA`);
};
function rigidMatrix(values: readonly number[], name: string) {
  if (values.length !== 16 || !finite(values)) throw new Error(`${name} must be a finite rigid matrix`);
  const columns = [0, 4, 8].map(i => new Vector3(values[i], values[i + 1], values[i + 2]));
  if ([values[3], values[7], values[11]].some(n => Math.abs(n!) > EPS) || Math.abs(values[15]! - 1) > EPS ||
    columns.some(v => Math.abs(v.lengthSq() - 1) > EPS) || Math.abs(columns[0]!.dot(columns[1]!)) > EPS ||
    Math.abs(columns[0]!.dot(columns[2]!)) > EPS || Math.abs(columns[1]!.dot(columns[2]!)) > EPS ||
    Math.abs(columns[0]!.clone().cross(columns[1]!).dot(columns[2]!) - 1) > EPS)
    throw new Error(`${name} must be a proper rigid matrix`);
  return new Matrix4().fromArray([...values]);
}
function convexQuad(quad: readonly SourcePoint2[], name: string) {
  if (quad.length !== 4 || quad.some(p => p.length !== 2 || !finite(p)))
    throw new Error(`${name} must have four finite points`);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!, b = quad[(i + 1) % 4]!, c = quad[(i + 2) % 4]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < EPS || (sign && cross * sign < 0)) throw new Error(`${name} must be convex and nondegenerate`);
    sign = Math.sign(cross);
  }
  return sign;
}
/** Four exact correspondences solve a planar projective map, not a crop resize. */
function homography(from: readonly SourcePoint2[], to: SourceQuad2) {
  const rows: number[][] = [];
  from.forEach(([x, y], i) => {
    const [u, v] = to[i]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(rows[r]![c]!) > Math.abs(rows[pivot]![c]!)) pivot = r;
    if (Math.abs(rows[pivot]![c]!) < EPS) throw new Error("Surface correspondences are singular");
    [rows[c], rows[pivot]] = [rows[pivot]!, rows[c]!];
    const divisor = rows[c]![c]!;
    for (let k = c; k <= 8; k++) rows[c]![k] = rows[c]![k]! / divisor;
    for (let r = 0; r < 8; r++) if (r !== c) {
      const factor = rows[r]![c]!;
      for (let k = c; k <= 8; k++) rows[r]![k] = rows[r]![k]! - factor * rows[c]![k]!;
    }
  }
  const h = rows.map(row => row[8]!);
  const denominators = from.map(([x, y]) => h[6]! * x + h[7]! * y + 1);
  if (!finite(h) || denominators.some(d => d <= EPS)) throw new Error("Surface mapping crosses a projective horizon");
  return h;
}

/** Copy original pixels only where a registered visible surface has evidence.
 * Hidden faces, invalid source pixels, missing depth and overlapping bindings stay holes.
 * Depth tolerance is solely half a saved 8-bit quantization step plus numeric epsilon. */
export function projectSourceArtwork(input: SourceArtworkProjectionInput): SourceArtworkProjection {
  const { source, target, bindings } = input, { width, height, camera } = target.view;
  dimensions(source.width, source.height, "Source"); dimensions(width, height, "Target");
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("Original source SHA256 is required");
  pixels(source.rgba, source.width, source.height, "Source");
  pixels(target.render, width, height, "Target render"); pixels(target.depth, width, height, "Target depth");
  if (target.normals) pixels(target.normals, width, height, "Target normals");
  const count = width * height;
  if (target.objects.length !== count || target.object_ids.some(id => !id) || new Set(target.object_ids).size !== target.object_ids.length)
    throw new Error("Target object mask and unique object IDs must be registered");
  if (target.objects.some(i => i < -1 || i >= target.object_ids.length)) throw new Error("Target mask has an unknown object index");
  if (source.valid_mask && (source.valid_mask.length !== source.width * source.height || source.valid_mask.some(v => v !== 0 && v !== 1)))
    throw new Error("Original source valid mask must be registered binary pixels");
  const { near, far } = target.view.depth;
  if (!finite([near, far, camera.near, camera.far]) || near < 0 || far <= near || camera.near <= 0 || camera.far <= camera.near)
    throw new Error("Registered camera and depth ranges are required");
  const world = rigidMatrix(camera.world_matrix, "Camera world matrix"), worldInverse = world.clone().invert();
  if (camera.projection_matrix.length !== 16 || !finite(camera.projection_matrix)) throw new Error("Camera projection must be finite");
  const projection = new Matrix4().fromArray(camera.projection_matrix);
  if (Math.abs(projection.determinant()) < EPS || !["perspective", "orthographic"].includes(camera.projection))
    throw new Error("Camera projection must be invertible and supported");
  const inverseProjection = projection.clone().invert(), depthTolerance = (far - near) / 510 + 1e-5;
  const ids = new Set<string>(), objectMatrices = new Map<string, readonly number[]>();
  const surfaces = bindings.map((binding, index) => {
    if (!binding.surface_id || ids.has(binding.surface_id) || !target.object_ids.includes(binding.object_id))
      throw new Error("Surface IDs must be unique and refer to a captured object");
    ids.add(binding.surface_id);
    if (binding.source_sha256 !== source.sha256) throw new Error("Surface binding source SHA mismatch");
    const matrix = rigidMatrix(binding.object_world_matrix, "Authored object matrix");
    const existing = objectMatrices.get(binding.object_id);
    if (existing && existing.some((v, i) => v !== binding.object_world_matrix[i])) throw new Error("One object cannot have conflicting authored transforms");
    objectMatrices.set(binding.object_id, binding.object_world_matrix);
    const quad = binding.object_local_quad;
    if (quad.length !== 4 || quad.some(p => p.length !== 3 || !finite(p))) throw new Error("Authored surface quad must have four finite points");
    const origin = new Vector3(...quad[0]), u = new Vector3(...quad[1]).sub(origin);
    const normal = u.clone().cross(new Vector3(...quad[3]).sub(origin));
    if (u.length() < EPS || normal.length() < EPS) throw new Error("Authored surface quad is degenerate");
    u.normalize(); normal.normalize(); const v = normal.clone().cross(u);
    const localQuad = quad.map(point => {
      const p = new Vector3(...point).sub(origin);
      if (Math.abs(normal.dot(p)) > 1e-6) throw new Error("Authored surface quad must be planar");
      return [p.dot(u), p.dot(v)] as SourcePoint2;
    });
    const sign = convexQuad(localQuad, "Authored surface quad");
    convexQuad(binding.source_pixel_quad, "Original source quad");
    if (binding.source_pixel_quad.some(([x, y]) => x < 0 || y < 0 || x > source.width || y > source.height))
      throw new Error("Original source quad is outside the source image");
    const normalWorld = normal.clone().transformDirection(matrix), originWorld = origin.clone().applyMatrix4(matrix);
    return { index, objectIndex: target.object_ids.indexOf(binding.object_id), origin, u, v, localQuad, sign,
      inverse: matrix.clone().invert(), plane: new Plane().setFromNormalAndCoplanarPoint(normalWorld, originWorld),
      normalView: normalWorld.clone().transformDirection(worldInverse), h: homography(localQuad, binding.source_pixel_quad) };
  });
  const byObject = new Map<number, typeof surfaces>();
  surfaces.forEach(surface => { const group = byObject.get(surface.objectIndex) ?? []; group.push(surface); byObject.set(surface.objectIndex, group); });
  const coverage = new Map<number, SourceProjectionCoverage>();
  byObject.forEach((_, index) => coverage.set(index, { object_id: target.object_ids[index]!, visible_pixels: 0, projected_pixels: 0,
    unsupported_pixels: 0, supported_coverage: 0, holes: Object.fromEntries(reasons.map(reason => [reason, 0])) as Record<SourceProjectionHoleReason, number> }));
  const output = target.render.slice(), projected = new Uint8Array(count), holes = new Uint8Array(count);
  const sourceIndices = new Int32Array(count).fill(-1), surfaceIndices = new Int32Array(count).fill(-1);
  const eye = new Vector3().setFromMatrixPosition(world), ray = new Ray(), rayNear = new Vector3(), rayFar = new Vector3();
  const hit = new Vector3(), local = new Vector3(), cameraHit = new Vector3(), observedNormal = new Vector3();
  let projectedCount = 0;
  for (let p = 0; p < count; p++) {
    const object = target.objects[p]!, group = byObject.get(object);
    if (!group) continue;
    const objectCoverage = coverage.get(object)!; objectCoverage.visible_pixels++;
    holes[p] = 1;
    let reason: SourceProjectionHoleReason = "no_surface", candidates = 0, sampled = -1, chosen = -1;
    const byte = target.depth[p * 4]!;
    if (!byte || target.depth[p * 4 + 1] !== byte || target.depth[p * 4 + 2] !== byte || target.depth[p * 4 + 3] !== 255) reason = "missing_depth";
    else {
      const nx = (p % width + .5) / width * 2 - 1, ny = 1 - (Math.floor(p / width) + .5) / height * 2;
      rayNear.set(nx, ny, -1).applyMatrix4(inverseProjection).applyMatrix4(world);
      rayFar.set(nx, ny, 1).applyMatrix4(inverseProjection).applyMatrix4(world);
      ray.origin.copy(camera.projection === "perspective" ? eye : rayNear);
      ray.direction.copy(rayFar).sub(ray.origin).normalize();
      const observedDepth = near + (1 - byte / 255) * (far - near);
      for (const surface of group) {
        // Winding declares the source-visible outward face; its back is unsupported.
        if (surface.plane.normal.dot(ray.direction) >= -EPS || !ray.intersectPlane(surface.plane, hit)) continue;
        local.copy(hit).applyMatrix4(surface.inverse).sub(surface.origin);
        const x = local.dot(surface.u), y = local.dot(surface.v);
        if (surface.localQuad.some(([ax, ay], i) => {
          const [bx, by] = surface.localQuad[(i + 1) % 4]!;
          return ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) * surface.sign < -EPS;
        })) continue;
        const expectedDepth = -cameraHit.copy(hit).applyMatrix4(worldInverse).z;
        if (expectedDepth < camera.near || expectedDepth > camera.far || Math.abs(expectedDepth - observedDepth) > depthTolerance) { reason = "depth_mismatch"; continue; }
        if (target.normals) {
          observedNormal.set(target.normals[p * 4]! / 255 * 2 - 1, target.normals[p * 4 + 1]! / 255 * 2 - 1, target.normals[p * 4 + 2]! / 255 * 2 - 1);
          if (target.normals[p * 4 + 3] !== 255 || observedNormal.lengthSq() < .5 || observedNormal.normalize().dot(surface.normalView) < NORMAL_MIN_COSINE) { reason = "normal_mismatch"; continue; }
        }
        const h = surface.h, denominator = h[6]! * x + h[7]! * y + 1;
        const sx = (h[0]! * x + h[1]! * y + h[2]!) / denominator, sy = (h[3]! * x + h[4]! * y + h[5]!) / denominator;
        const ix = Math.floor(sx), iy = Math.floor(sy), sourcePixel = iy * source.width + ix;
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || ix < 0 || iy < 0 || ix >= source.width || iy >= source.height ||
          source.rgba[sourcePixel * 4 + 3] !== 255 || (source.valid_mask && source.valid_mask[sourcePixel] !== 1)) { reason = "source_invalid"; continue; }
        candidates++; sampled = sourcePixel; chosen = surface.index;
      }
    }
    if (candidates === 1) {
      output.set(source.rgba.subarray(sampled * 4, sampled * 4 + 4), p * 4);
      projected[p] = 1; holes[p] = 0; sourceIndices[p] = sampled; surfaceIndices[p] = chosen;
      objectCoverage.projected_pixels++; projectedCount++;
    } else {
      if (candidates > 1) reason = "ambiguous_surface";
      objectCoverage.holes[reason]++; objectCoverage.unsupported_pixels++;
    }
  }
  coverage.forEach(value => { value.supported_coverage = value.visible_pixels ? value.projected_pixels / value.visible_pixels : 0; });
  return { rgba: output, projected, holes, source_pixel_indices: sourceIndices, surface_indices: surfaceIndices,
    proof: { version: "source-art-surface-projection-v1", source_sha256: source.sha256,
      source_hash_verification: "binding_match_only_encoded_source_verification_required", sampling: "nearest_original_pixel",
      depth_tolerance_m: depthTolerance, normal_min_cosine: target.normals ? NORMAL_MIN_COSINE : null,
      projected_pixels: projectedCount, protected_pixels: count - projectedCount, changed_protected_pixels: 0,
      objects: [...coverage.values()], surfaces: bindings.map(binding => ({ ...binding, object_world_matrix: [...binding.object_world_matrix],
        object_local_quad: binding.object_local_quad.map(p => [...p]) as unknown as SourceQuad3,
        source_pixel_quad: binding.source_pixel_quad.map(p => [...p]) as unknown as SourceQuad2 })) } };
}
