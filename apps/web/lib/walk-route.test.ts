import { expect, it } from "vitest";
import { angleDifference, walkCheckpoints, WALK_CHECKPOINT_METRES } from "./walk-route";

const deg = (rad: number) => Math.round(rad * 180 / Math.PI * 1e6) / 1e6;
const near = (n: number) => Math.round(n * 1e6) / 1e6 || 0;
const poses = (route: Parameters<typeof walkCheckpoints>[0]) => walkCheckpoints(route).map(c => [near(c.x), near(c.z), deg(c.yaw)]);

it("puts a checkpoint every 4 m on a straight walk", () => {
  expect(WALK_CHECKPOINT_METRES).toBe(4);
  // Yaw 0 walks toward -z.
  expect(poses([{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -20, yaw: 0 }])).toEqual([0, -4, -8, -12, -16, -20].map(z => [0, z, 0]));
  // The route's end is a checkpoint even when it is not on the 4 m grid.
  expect(poses([{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -6, yaw: 0 }])).toEqual([[0, 0, 0], [0, -4, 0], [0, -6, 0]]);
});

it("turns in place at a corner with checkpoints at most 30 degrees apart", () => {
  const route = [{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -8, yaw: 0 }, { x: -8, z: -8, yaw: Math.PI / 2 }];
  expect(poses(route)).toEqual([[0, 0, 0], [0, -4, 0], [0, -8, 0], [0, -8, 30], [0, -8, 60], [0, -8, 90], [-4, -8, 90], [-8, -8, 90]]);
  const turns = walkCheckpoints(route).slice(1).map((c, i, all) => Math.abs(deg(angleDifference(c.yaw, (i ? all[i - 1]! : walkCheckpoints(route)[0]!).yaw))));
  expect(Math.max(...turns)).toBeLessThanOrEqual(30);
  // Distance and turn add up from the last checkpoint: 2 m then a 40 degree turn closes one at 30 degrees.
  expect(poses([{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -2, yaw: 0 }, { x: 0, z: -2, yaw: -40 * Math.PI / 180 }])).toEqual([[0, 0, 0], [0, -2, -30], [0, -2, -40]]);
});

it("refuses a walk that needs more than 12 checkpoints, or fewer than 2", () => {
  expect(walkCheckpoints([{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -44, yaw: 0 }])).toHaveLength(12);
  expect(() => walkCheckpoints([{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -48, yaw: 0 }])).toThrow(/13 checkpoints, more than 12/);
  // No leg to make: no route, one waypoint, or waypoints at one pose.
  for (const route of [[], [{ x: 1, z: 2, yaw: 0 }], [{ x: 1, z: 2, yaw: 0 }, { x: 1, z: 2, yaw: 0 }]]) expect(() => walkCheckpoints(route)).toThrow(/at least 2 checkpoints/);
  expect(walkCheckpoints([{ x: 0, z: 0, yaw: 0 }, { x: 0, z: -1, yaw: 0 }])).toHaveLength(2);
});
