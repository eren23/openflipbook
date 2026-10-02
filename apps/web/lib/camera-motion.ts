import { Matrix4, Vector3 } from "three";
import { checkpointTimes, orbitPosition, sampleCameraPath } from "./camera-path";
import { parseSavedCameraPath } from "./saved-camera-path";
import { CreatorError } from "./creator-error";
import type { ViewCapture } from "./place-view";

export const H3_CAMERA_MODEL = "minimax/h3-max/camera-controls";
export const H3_CAMERA_ADAPTER = "h3-source-relative-v2-measured";
// Studies saved under v1 keep their v1 preparation, comparison and archives.
export const H3_CAMERA_ADAPTER_V1 = "h3-source-relative-v1-hypothesis";
export const H3_CAMERA_SCHEMA = "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/camera-controls";
// Measured on 2026-09-27 against scene geometry, 8 clips (evidence:
// ~/Videos/openflipbook/h3-calibration-2026-09-27, measure3.py). H3 delivers
// about 0.6 of a requested push; azimuth and elevation were measured only up
// to these sizes. providers/camera_motion.py must use the same numbers.
export const H3_LIMITS = { distance_gain: 0.6, min_distance: 0.2, max_azimuth_deg: 30, max_elevation_deg: 15 };
export const H3_NOTES = {
  azimuth: "about a third of the turn arrives as a pan; the target drifts toward the travel direction",
  elevation: "about half of the rise arrives, mostly as tilt",
  pull_back: "pull-back distance is unverified; only pushes were measured",
  push_floor: "the push is clamped at the 0.2 floor; the clip ends farther away than the path",
};
// The distance ratio to send so that the requested ratio r arrives.
export const h3SentDistance = (r: number) => r < 1 ? Math.max(H3_LIMITS.min_distance, 1 - (1 - r) / H3_LIMITS.distance_gain) : r;

// H3 receives one image and subject-relative poses, not these reference cameras.
export function prepareCameraMotion(capture: ViewCapture, adapter: typeof H3_CAMERA_ADAPTER | typeof H3_CAMERA_ADAPTER_V1 = H3_CAMERA_ADAPTER) {
  if (capture.mode !== "orbit" || capture.sources.length !== 1 || capture.floor_id !== null)
    throw new CreatorError("Camera motion requires a single-place exterior orbit view", 400);
  if (!capture.path?.target_id) throw new CreatorError("Select a landmark and save its camera path", 400);
  const path = parseSavedCameraPath(capture.path, capture.camera, capture.sources);
  if (path.time !== 0) throw new CreatorError("Capture the path at its start before preparing motion", 409);
  if (!Number.isInteger(path.duration)) throw new CreatorError("H3 duration must be a whole number of seconds", 400);
  const first = path.keyframes[0]!, v1 = adapter === H3_CAMERA_ADAPTER_V1;
  const relative = path.keyframes.map(frame => ({
    time: frame.time,
    // Do not wrap angles: 170 -> 190 is +20; 170 -> -170 is an authored -340.
    azimuth: frame.azimuth - first.azimuth,
    elevation: frame.elevation - first.elevation,
    distance: frame.distance / first.distance,
  }));
  if (relative.some(frame => !Object.values(frame).every(Number.isFinite)
    || frame.distance <= 0 || Math.abs(frame.elevation) > 90))
    throw new CreatorError("The source-relative path exceeds H3 camera limits", 400);
  const travel = relative.slice(1).reduce((sum, frame, index) => sum + Math.abs(frame.azimuth - relative[index]!.azimuth), 0);
  if (travel > 32 * 360) throw new CreatorError("H3 camera path exceeds 32 turns", 400);
  const camera_trajectory = v1 ? relative : relative.map(frame => ({ ...frame, distance: h3SentDistance(frame.distance) }));
  const pivot = new Vector3(...path.pivot), checkpoints = v1 ? [] : checkpointTimes(path.keyframes);
  const times = [...new Set([0, 0.25, 0.5, 0.75, 1, ...path.keyframes.map(frame => frame.time), ...checkpoints])].sort((a, b) => a - b);
  const turn = Math.max(...relative.map(frame => Math.abs(frame.azimuth))), rise = Math.max(...relative.map(frame => Math.abs(frame.elevation)));
  const limit_issues = [
    ...turn > H3_LIMITS.max_azimuth_deg ? [`H3 camera controls are measured only up to ${H3_LIMITS.max_azimuth_deg}° of turn per clip`] : [],
    ...rise > H3_LIMITS.max_elevation_deg ? [`H3 camera controls are measured only up to ${H3_LIMITS.max_elevation_deg}° of rise per clip`] : [],
  ];
  const calibration_notes = [
    ...turn > 0 ? [H3_NOTES.azimuth] : [], ...rise > 0 ? [H3_NOTES.elevation] : [],
    ...relative.some(frame => frame.distance > 1) ? [H3_NOTES.pull_back] : [],
    ...relative.some(frame => 1 - (1 - frame.distance) / H3_LIMITS.distance_gain < H3_LIMITS.min_distance) ? [H3_NOTES.push_floor] : [],
  ];
  return {
    model: H3_CAMERA_MODEL, adapter,
    calibration: v1 ? "unverified" as const : "measured" as const,
    schema: { url: H3_CAMERA_SCHEMA, checked_on: "2026-09-14" },
    parameters: {
      duration: path.duration, resolution: "768P" as const, prompt_expansion_mode: "balanced" as const,
      enable_safety_checker: true, sync_mode: false,
      prompt: "Keep the place and its architecture unchanged. Only the camera moves. Preserve the landmark, doors, windows, materials and neighboring buildings.",
      camera_trajectory,
    },
    mapping: { azimuth_sign: 1, elevation_sign: 1, angular_origin: "source_pose", distance_unit_metres: first.distance },
    path,
    reference_cameras: times.map(time => {
      const pose = sampleCameraPath(path.keyframes, time), position = orbitPosition(pivot, pose);
      return { time, seconds: time * path.duration, position: position.toArray(),
        world_matrix: time === 0 ? [...capture.camera.world_matrix]
          : new Matrix4().lookAt(position, pivot, new Vector3(0, 1, 0)).setPosition(position).toArray(),
        projection_matrix: [...capture.camera.projection_matrix] };
    }),
    checks_required: ["provider_axis_and_distance_calibration", "current_geometry_clearance",
      "landmark_framing_and_visibility", "source_image_bytes", "explicit_priced_generation_consent"],
    // v2 only, after the v1 keys, so v1 output and its hash stay unchanged.
    // checkpoints are indices into reference_cameras.
    ...v1 ? {} : { checkpoints: checkpoints.map(time => times.indexOf(time)), limit_issues, calibration_notes },
  };
}
