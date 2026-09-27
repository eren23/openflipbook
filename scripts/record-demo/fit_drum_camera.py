"""Bounded single-view fit; holds footprints fixed and reports held-out landmarks.

Run with: uv run --with scipy==1.17.1 scripts/record-demo/fit_drum_camera.py
This fits an authored hypothesis. It does not reconstruct unseen surfaces.
"""
import json
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "apps/web/public/demos/ankh-morpork"


def project(parameters, anchors, width, height):
    x, y, z, yaw, pitch, fov, eave, ridge = parameters[:8]
    forward = np.array([np.cos(pitch) * np.cos(yaw), np.sin(pitch), np.cos(pitch) * np.sin(yaw)])
    right = np.cross(forward, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    points = np.array([a["point"] for a in anchors], dtype=float)
    for i, anchor in enumerate(anchors):
        if anchor.get("height") == "eave":
            points[i, 1] = eave
        elif anchor.get("height") == "ridge":
            points[i, 1] = ridge
        if len(parameters) > 8:
            if anchor["id"] == "rear_eave":
                points[i, 2] = 13 + parameters[8]
            elif anchor["id"] == "roof_ridge":
                points[i, 0] = 13 + parameters[9]
    relative = points - [x, y, z]
    depth = relative @ forward
    focal = height / (2 * np.tan(np.radians(fov) / 2))
    pixels = np.column_stack([width / 2 + focal * (relative @ right) / depth, height / 2 - focal * (relative @ up) / depth])
    return pixels


def fit():
    observations = json.loads((ASSETS / "alignment-observations.json").read_text())
    anchors = observations["anchors"]
    measured = np.array([a["pixel"] for a in anchors])
    selected = np.array([a["fit"] for a in anchors])
    initial = np.array([27, 2.2, 9.4, np.arctan2(6.3, -14), np.arctan2(0.6, np.hypot(14, 6.3)), 60, 5.5, 7])
    lower = [25.8, 1.6, 8.3, 2.5, -0.04, 50, 5.1, 7]
    upper = [28.5, 2.8, 10.1, 2.9, 0.13, 72, 6.6, 9.5]

    def residual(parameters):
        pixels = project(parameters, anchors, observations["width"], observations["height"])
        # Keep the underdetermined single-view solution close to the authored camera.
        prior = (parameters[:6] - initial[:6]) * [6, 15, 6, 30, 30, 0.6]
        return np.r_[(pixels - measured)[selected].ravel(), prior]

    solved = least_squares(residual, initial, bounds=(lower, upper), loss="soft_l1", f_scale=15, max_nfev=4000)
    # A camera fit can improve the training corners while moving the held-out well.
    # Keep a conservative candidate that changes only the tavern's vertical profile.
    vertical = least_squares(lambda heights: residual(np.r_[initial[:6], heights]), initial[6:], bounds=([5.1, 7], [6.6, 10.5]), loss="soft_l1", f_scale=15)
    conservative = np.r_[initial[:6], vertical.x]
    shape = least_squares(lambda values: residual(np.r_[initial[:6], values]), [*vertical.x, 5.4, 0], bounds=([5.1, 7, 5.4, -2], [6.6, 10.5, 7.2, 2]), loss="soft_l1", f_scale=15)
    footprint = np.r_[initial[:6], shape.x]
    results = []
    for name, parameters in [("original", initial), ("free_camera", solved.x), ("vertical_only", conservative), ("shape_fit", footprint)]:
        pixels = project(parameters, anchors, observations["width"], observations["height"])
        errors = np.linalg.norm(pixels - measured, axis=1)
        results.append({"name": name, "parameters": parameters.tolist(), "fit_rms_px": float(np.sqrt(np.mean(errors[selected] ** 2))), "held_out_rms_px": float(np.sqrt(np.mean(errors[~selected] ** 2))), "anchors": [{"id": a["id"], "projected": pixel.tolist(), "error_px": float(error)} for a, pixel, error in zip(anchors, pixels, errors)]})
    result = {"version": 2, "solver": "scipy.optimize.least_squares", "success": bool(solved.success and vertical.success and shape.success), "selected": "shape_fit", "footprints_changed": True, "footprint_change": "Rear depth changes; front wall, entrance, camera, barrels and well remain fixed. Preview before applying.", "observations": observations, "results": results}
    (ASSETS / "alignment-fit.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"selected": result["selected"], "results": [{k: r[k] for k in ["name", "fit_rms_px", "held_out_rms_px"]} for r in results]}, indent=2))
    return result


if __name__ == "__main__":
    fit()
