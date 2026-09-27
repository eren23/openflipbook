import { expect, it } from "vitest";
import { WalkInput, walkKey } from "./walk-input";

function consume(input: WalkInput, dt: number, key: "w" | "ArrowLeft" = "w") {
  let seconds = 0;
  for (let i = 0; i < 100 && input.active; i++) seconds += input.sample(dt)(key) * dt;
  return seconds;
}
it.each([1 / 30, 1 / 60, 1 / 144])("makes short taps frame-rate independent at %s", dt => {
  const input = new WalkInput(); input.hold("w", "pointer:1");
  const first = input.sample(dt)("w") * dt; input.release("pointer:1", 0.2);
  expect(first + consume(input, dt)).toBeCloseTo(0.2, 8); expect(input.active).toBe(false);
});
it("keeps physical keys independent from pointers and keyboard repeat does not reset a hold", () => {
  const input = new WalkInput(); input.hold("w", "keyboard:w"); input.hold("w", "pointer:1");
  for (let i = 0; i < 30; i++) { input.hold("w", "keyboard:w"); expect(input.sample(0.02)("w")).toBe(1); }
  input.release("pointer:1", 0.2); expect(input.sample(0.02)("w")).toBe(1);
  input.release("keyboard:w", 0.2); expect(input.active).toBe(false);
});
it("bounds queued activation and clears all motion on cancellation or blur", () => {
  const input = new WalkInput(); for (let i = 0; i < 100; i++) input.tap("w");
  expect(consume(input, 0.03)).toBeCloseTo(0.4);
  input.hold("w", "pointer:1"); input.release("pointer:1"); expect(input.active).toBe(false);
  input.hold("w", "pointer:2"); input.tap("ArrowLeft"); input.clear(); input.release("pointer:2", 0.2);
  expect(input.active).toBe(false); expect(input.sample(0.02)("w")).toBe(0);
});
it("normalizes shifted movement keys without swallowing unrelated text", () => {
  expect(walkKey("W")).toBe("w"); expect(walkKey("ArrowLeft")).toBe("ArrowLeft"); expect(walkKey("Enter")).toBeNull();
});
it("turns by fifteen degrees per keyboard button activation at the existing 1.5 rad/s rate", () => {
  const input = new WalkInput(); input.tap("ArrowLeft"); expect(consume(input, 1 / 60, "ArrowLeft") * 1.5).toBeCloseTo(Math.PI / 12, 8);
});
