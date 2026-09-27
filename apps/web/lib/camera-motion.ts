import { Matrix4, Vector3 } from "three";
import { orbitPosition, sampleCameraPath } from "./camera-path";
import { parseSavedCameraPath } from "./saved-camera-path";
import { CreatorError } from "./creator-error";
import type { ViewCapture } from "./place-view";

export const H3_CAMERA_MODEL = "minimax/h3-max/camera-controls";
export const H3_CAMERA_ADAPTER = "h3-source-relative-v1-hypothesis";
export const H3_CAMERA_SCHEMA = "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/camera-controls";

// This conversion is a calibration hypothesis, not a learned world-to-H3 contract.
// H3 receives one image and subject-relative poses, not these reference cameras.
export function prepareCameraMotion(capture: ViewCapture) {
  if (capture.mode !== "orbit" || capture.sources.length !== 1 || capture.floor_id !== null)
    throw new CreatorError("Camera motion requires a single-place exterior orbit view", 400);
  if (!capture.path?.target_id) throw new CreatorError("Select a landmark and save its camera path", 400);
  const path = parseSavedCameraPath(capture.path, capture.camera, capture.sources);
  if (path.time !== 0) throw new CreatorError("Capture the path at its start before preparing motion", 409);
  if (!Number.isInteger(path.duration)) throw new CreatorError("H3 duration must be a whole number of seconds", 400);
  const first = path.keyframes[0]!;
  const camera_trajectory = path.keyframes.map(frame => ({
    time: frame.time,
    // Do not wrap angles: 170 -> 190 is +20; 170 -> -170 is an authored -340.
    azimuth: frame.azimuth - first.azimuth,
    elevation: frame.elevation - first.elevation,
    distance: frame.distance / first.distance,
  }));
  if (camera_trajectory.some(frame => !Object.values(frame).every(Number.isFinite)
    || frame.distance <= 0 || Math.abs(frame.elevation) > 90))
    throw new CreatorError("The source-relative path exceeds H3 camera limits", 400);
  const travel = camera_trajectory.slice(1).reduce((sum, frame, index) => sum + Math.abs(frame.azimuth - camera_trajectory[index]!.azimuth), 0);
  if (travel > 32 * 360) throw new CreatorError("H3 camera path exceeds 32 turns", 400);
  const pivot = new Vector3(...path.pivot);
  const times = [...new Set([0, 0.25, 0.5, 0.75, 1, ...path.keyframes.map(frame => frame.time)])].sort((a, b) => a - b);
  return {
    model: H3_CAMERA_MODEL, adapter: H3_CAMERA_ADAPTER,
    calibration: "unverified" as const,
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
  };
}
