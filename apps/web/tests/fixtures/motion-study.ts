import type { MotionStudyDoc } from "@/lib/motion-study";
import { H3_CAMERA_ADAPTER, H3_CAMERA_MODEL } from "@/lib/camera-motion";

// Synthetic masks for contract tests, never a claim about generated video.
export function motionStudyFixture(): MotionStudyDoc {
  return {
    _id: "world:study", id: "study", session_id: "world", view_id: "view", preparation_sha256: "prep",
    client_preflight: { status: "clear" }, preparation: { model: H3_CAMERA_MODEL, adapter: H3_CAMERA_ADAPTER,
      path: { target_id: "target" }, parameters: { duration: 6, resolution: "768P", camera_trajectory: [
        { time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 1, azimuth: 20, elevation: 0, distance: 1 },
      ] } },
    source: { view: { width: 640, height: 480 }, definitions: [{ definition: { objects: [
      { id: "target", label: "Target" }, { id: "left", label: "Left tower" }, { id: "right", label: "Right tower" },
    ] } }] },
    frames: [0, .25, .5, .75, 1].map(time => ({ seconds: time * 6, time, measurements: { unknown_pixels: 0,
      landmarks: ["target", "left", "right"].map((id, i) => ({ object_id: id, fraction: .04, pixels: 12288, touches_frame: false,
        bounds: [.1 + i * .25 + time * .08, .3, .25 + i * .25 + time * .08, .6], centroid: null })) } })),
  } as unknown as MotionStudyDoc;
}
