/** Read-only replay of exact bytes saved by earlier pilot phases. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const localName = file => {
  assert.ok(typeof file === "string" && file.length && ![".", ".."].includes(file)
    && basename(file) === file, "Saved media receipt must name a local evidence file");
  return file;
};

/** Read every owned saved chunk, including its independent scene/build routes.
 * Walk poses are stored separately; no pose is reset or excluded from a write.
 */
export async function readPilotReplayNetwork({ manifest, get }) {
  const sid = manifest.world.session_id, rootId = manifest.world.place_id;
  assert.ok(safeId(sid) && safeId(rootId), "Invalid owned replay world");
  const path = `/api/world/${sid}/places/${rootId}/connections`;
  const response = await get(path), network = response.network;
  assert.ok(network === null || Array.isArray(network?.chunks) && Array.isArray(network?.connections), "Invalid saved connected network");
  const placeIds = network ? network.chunks.map(chunk => chunk.scene?.place_id) : [rootId];
  assert.ok(placeIds.length >= 1 && placeIds.length <= 16 && placeIds.includes(rootId)
    && placeIds.every(safeId) && new Set(placeIds).size === placeIds.length, "Invalid saved network places");
  const reads = await Promise.allSettled(placeIds.map(async placeId => {
    const base = `/api/world/${sid}/places/${placeId}`;
    const sceneResponse = await get(`${base}/scene`), scene = sceneResponse.scene;
    assert.ok(scene && scene.session_id === sid && scene.place_id === placeId && Number.isSafeInteger(scene.revision)
      && scene.revision >= 1 && Array.isArray(scene.definition?.objects), "Saved scene identity or revision is invalid");
    const chunk = network?.chunks.find(item => item.scene.place_id === placeId);
    if (chunk) {
      assert.ok(Number.isFinite(chunk.x) && Number.isFinite(chunk.z), "Saved chunk transform is invalid");
      // The scene route removes its internal planner fence; the older network
      // route can still include it. Compare the same public canonical fields.
      const canonical = Object.fromEntries(Object.entries(chunk.scene).filter(([key]) => key !== "text_edit_fence"));
      assert.deepEqual(scene, canonical, "Owner scene differs from its saved network chunk");
    }
    const library = await get(`${base}/build`); assert.ok(Array.isArray(library.jobs), "Owned build jobs are missing");
    return { place_id: placeId, scene, scene_sha256: sha(JSON.stringify(scene)),
      definition_sha256: sha(JSON.stringify(scene.definition)), jobs: library.jobs, jobs_sha256: sha(JSON.stringify(library.jobs)) };
  }));
  // Inspect all independent read outcomes before reporting a failure.
  const failures = reads.filter(read => read.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(read => read.reason), "Owned replay network reads failed");
  const places = reads.map(read => read.value), buildings = places.flatMap(place =>
    place.scene.definition.objects.filter(object => object.kind === "building"));
  assert.ok(buildings.every(building => safeId(building.id)) && new Set(buildings.map(building => building.id)).size === buildings.length,
    "Saved network building IDs are ambiguous");
  if (manifest.extensions?.growth) {
    for (const area of ["west", "north"]) {
      const state = manifest.extension_phases?.[`growth_${area}`];
      assert.equal(state?.status, "complete", "Complete the reviewed growth before final replay");
      const saved = places.find(place => place.place_id === state.boundary?.place_id);
      assert.ok(saved, "Reviewed growth place is absent from the network");
      assert.equal(saved.scene.revision, state.result.revision, "Reviewed growth revision changed");
      assert.equal(saved.definition_sha256, state.result.definition_sha256, "Reviewed growth geometry changed");
    }
    assert.equal(places.length, 4, "The reviewed pilot has four connected places");
    assert.equal(buildings.length, 8, "The reviewed expanded pilot has eight saved buildings");
  }
  return { version: 1, path, network, network_sha256: sha(JSON.stringify(network)), places,
    buildings: buildings.length, connections: network?.connections.length ?? 0, generation_submissions: 0 };
}

export function assertPilotReplayNetworkUnchanged(before, after) {
  assert.equal(after.network_sha256, before.network_sha256, "Replay changed the exact saved network");
  assert.deepEqual(after.network, before.network, "Replay changed a saved scene, transform or connection");
  assert.deepEqual(after.places, before.places, "Replay changed an owned scene, revision or generation job");
  assert.equal(after.buildings, before.buildings); assert.equal(after.connections, before.connections);
  return { places: after.places.map(place => ({ place_id: place.place_id, revision: place.scene.revision,
    scene_sha256: place.scene_sha256, definition_sha256: place.definition_sha256, jobs_sha256: place.jobs_sha256,
    jobs: place.jobs.length })), buildings: after.buildings, connections: after.connections,
    network_sha256: after.network_sha256, generation_submissions: 0,
    scope: "All saved connected scenes, authored transforms, connections and per-place build jobs; motion remains scoped to its frozen source." };
}

export async function verifySavedPilotMedia({ manifest, page, directory, atomicJson }) {
  const sid = manifest.world.session_id; assert.ok(safeId(sid));
  const files = await readdir(directory), receipts = [];
  const local = async (kind, file, expected) => {
    localName(file);
    assert.match(expected, /^[a-f0-9]{64}$/);
    const bytes = await readFile(join(directory, file));
    assert.equal(sha(bytes), expected, "Saved evidence bytes changed before replay");
    return { kind, file, sha256: expected, bytes: bytes.length, data: bytes };
  };
  const check = async (kind, path, file, expected, expectedBytes) => {
    const saved = await local(kind, file, expected);
    if (expectedBytes !== undefined) assert.equal(saved.bytes, expectedBytes, "Saved media byte count changed");
    const response = await page.request.get(path, { maxRedirects: 0 }); assert.equal(response.status(), 200, "Owned media failed to reopen");
    const bytes = await response.body(); assert.equal(sha(bytes), expected, "Reopened media differs from its original receipt");
    assert.equal(bytes.length, saved.bytes);
    receipts.push({ kind, path, file, sha256: expected, bytes: bytes.length });
  };
  const savedFile = prefix => {
    const matches = files.filter(file => file.startsWith(prefix) && /^[a-f0-9]{64}\.png$/.test(file.slice(prefix.length)));
    assert.equal(matches.length, 1, "One original immutable image receipt is required for replay");
    return { file: matches[0], hash: matches[0].slice(prefix.length, -4) };
  };
  if (manifest.capture_view_id) {
    assert.ok(safeId(manifest.capture_view_id));
    for (const pass of ["render", "depth", "normals", "objects"]) {
      const saved = savedFile(`capture-${manifest.capture_view_id}-${pass}.`);
      await check(`saved-view-${pass}`, `/api/world/${sid}/views/${manifest.capture_view_id}/${pass}`, saved.file, saved.hash);
    }
  }
  for (const pass of manifest.phases.illustration?.source?.passes ?? []) {
    const viewId = manifest.phases.illustration.source.view_id;
    assert.ok(safeId(viewId)); assert.ok(["render", "depth", "normals", "objects"].includes(pass.pass));
    await check(`current-illustration-source-${pass.pass}`, `/api/world/${sid}/views/${viewId}/${pass.pass}`, pass.file, pass.sha256);
  }
  const illustration = manifest.phases.illustration;
  for (const receipt of illustration?.original_receipts ?? []) {
    assert.equal(basename(receipt.file), receipt.file); assert.equal(sha(await readFile(join(directory, receipt.file))), receipt.sha256, "Original failure receipt changed");
  }
  const illustrations = [...(illustration?.original_result?.assets ?? []), ...(illustration?.result?.assets ?? [])];
  for (const asset of illustrations.filter((value, index) => illustrations.findIndex(other => other.id === value.id) === index)) {
    assert.ok(safeId(asset.id)); assert.ok(["image/png", "image/jpeg"].includes(asset.content_type));
    const file = `${asset.id}.${asset.sha256}.${asset.content_type === "image/png" ? "png" : "jpg"}`;
    await check("illustration", `/api/world/${sid}/illustrations/${asset.id}`, file, asset.sha256);
  }
  const motion = manifest.phases.motion, retry = motion?.retry;
  if (motion?.result?.submitted) {
    localName(motion.result.video_file);
    assert.ok(safeId(manifest.motion_study_id), "Submitted original clip has no saved study");
    assert.equal(motion.result.study_id, manifest.motion_study_id, "Original clip names another study");
  }
  let preservedLibrary;
  if (retry) {
    const original = retry.original;
    assert.ok(original && motion.result?.submitted, "Retry must preserve its acknowledged original clip");
    assert.equal(sha(JSON.stringify(original.result)), original.result_sha256, "Frozen original result is corrupted");
    assert.deepEqual(motion.result, original.result, "Retry changed the original motion result");
    assert.ok(Array.isArray(original.files) && original.files.length, "Original motion evidence receipts are missing");
    for (const receipt of original.files) {
      for (const file of [receipt.file, receipt.archive_file]) {
        const saved = await local("preserved-original-motion", file, receipt.sha256);
        receipts.push({ kind: saved.kind, file: saved.file, sha256: saved.sha256, bytes: saved.bytes });
      }
    }
    const saved = await local("preserved-original-motion-library", original.library_file, original.library_sha256);
    preservedLibrary = JSON.parse(saved.data.toString("utf8"));
    receipts.push({ kind: saved.kind, file: saved.file, sha256: saved.sha256, bytes: saved.bytes });
    assert.equal(original.result.review?.outcome?.status, "fail", "Retry must retain the original failed comparison");
    assert.equal(original.result.accepted, false, "The original failed clip must remain unaccepted");
  }
  const replayStudy = async ({ studyId, result, name, references, baseline }) => {
    assert.ok(safeId(studyId), "Saved study identity is invalid");
    const response = await page.request.get(`/api/world/${sid}/motion-studies/${studyId}/jobs`, { maxRedirects: 0 });
    assert.equal(response.status(), 200); const library = await response.json();
    assert.ok(library.comparison?.plan?.frames.length >= 5, "Saved comparison references are missing");
    assert.equal(sha(JSON.stringify(library.comparison.plan)), library.comparison.sha256, "Saved comparison hash changed");
    if (references) {
      assert.equal(references.length, library.comparison.plan.frames.length, "Complete retry reference receipts required");
      assert.ok(references.every((reference, index) => reference.index === index && Number.isSafeInteger(reference.bytes)
        && reference.bytes > 0 && /^[a-f0-9]{64}$/.test(reference.sha256)), "Retry references must retain their original order and byte receipts");
      assert.equal(new Set(references.map(reference => reference.file)).size, references.length, "Retry reference filenames are ambiguous");
    }
    await atomicJson(join(directory, `replay-${name}-library.json`), library);
    for (let index = 0; index < library.comparison.plan.frames.length; index++) {
      const reference = references?.[index], saved = reference ?? savedFile(`motion-reference-${index}.`);
      await check(`${name}-reference`, `/api/world/${sid}/motion-studies/${studyId}/${index}/render`, saved.file,
        reference ? reference.sha256 : saved.hash, reference?.bytes);
    }
    if (result?.submitted) {
      assert.equal(result.study_id, studyId); assert.ok(safeId(result.asset?.id), "Saved motion output identity is invalid");
      const asset = library.assets?.find(item => item.id === result.asset.id);
      assert.ok(asset?.comparison && library.jobs?.some(job => job.status === "ready" && job.asset_id === asset.id),
        "The original acknowledged ready clip is missing");
      assert.equal(sha(JSON.stringify(asset.comparison.plan)), asset.comparison.sha256, "Frozen output comparison is corrupted");
      assert.deepEqual(asset.media, result.asset.media, "Saved output media metadata changed");
      assert.deepEqual(asset.comparison, result.asset.comparison, "Saved output comparison changed");
      if (result.review) {
        const saved = await local(`${name}-review`, result.review.review_file, result.review.review_sha256);
        const review = library.reviews?.find(item => item.id === result.review.id && item.asset_id === asset.id);
        assert.ok(review, "Original recorded motion review failed to reopen");
        assert.deepEqual(review.review, JSON.parse(saved.data.toString("utf8")), "Saved actual motion observations changed");
        assert.deepEqual(review.outcome, result.review.outcome, "Saved motion assessment changed");
        if (review.outcome.status !== "pass") assert.ok(result.accepted === false && library.accepted_id !== asset.id,
          "A failed or incomplete output became accepted during replay");
        receipts.push({ kind: saved.kind, file: saved.file, sha256: saved.sha256, bytes: saved.bytes });
      }
      await check(`${name}-video`, `/api/world/${sid}/motion-studies/${studyId}/videos/${asset.id}`, result.video_file, result.video_sha256);
    }
    if (baseline) {
      assert.deepEqual(library.jobs, baseline.jobs, "Retry changed original ready generation jobs");
      assert.deepEqual(library.reviews, baseline.reviews, "Retry changed the original failed review");
      assert.equal(library.accepted_id, baseline.accepted_id, "Retry changed the original study selection");
      for (const original of baseline.assets) {
        const reopened = library.assets.find(asset => asset.id === original.id);
        assert.ok(reopened, "Original study output was removed");
        assert.deepEqual(reopened.media, original.media); assert.deepEqual(reopened.comparison, original.comparison);
      }
    }
  };
  if (manifest.motion_study_id) await replayStudy({ studyId: manifest.motion_study_id, result: motion?.result,
    name: "motion", baseline: preservedLibrary });
  if (retry?.study_id) {
    assert.notEqual(retry.study_id, manifest.motion_study_id, "Retry cannot overwrite the original study");
    assert.ok(Array.isArray(retry.reference_receipts), "Retry reference receipts are missing");
    await replayStudy({ studyId: retry.study_id, result: retry.result, name: "motion-retry", references: retry.reference_receipts });
  } else assert.ok(!retry?.result?.submitted, "Submitted retry has no saved study");
  await atomicJson(join(directory, "replay-media-receipts.json"), receipts);
  return receipts;
}
