import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WalkInput } from "@/lib/walk-input";
import WalkControls from "./walk-controls";

it("supports keyboard/assistive activation without double-counting pointer clicks", () => {
  const input = new WalkInput(), tap = vi.spyOn(input, "tap"); render(<WalkControls input={input}/>);
  fireEvent.click(screen.getByRole("button", { name: "Walk forward" }), { detail: 0 });
  expect(tap).toHaveBeenCalledTimes(1); expect(tap).toHaveBeenCalledWith("w");
  fireEvent.click(screen.getByRole("button", { name: "Walk forward" }), { detail: 1 }); expect(tap).toHaveBeenCalledTimes(1);
  expect(input.sample(0.1)("w")).toBe(1); expect(input.sample(0.1)("w")).toBe(1); expect(input.active).toBe(false);
});
it("releases held controls on cancellation and lost capture instead of latching movement", () => {
  const input = new WalkInput(), release = vi.spyOn(input, "release"); render(<WalkControls input={input}/>);
  const button = screen.getByRole("button", { name: "Walk forward" });
  fireEvent.pointerCancel(button, { pointerId: 3 }); fireEvent.lostPointerCapture(button, { pointerId: 3 });
  expect(release).toHaveBeenCalledTimes(2); expect(input.active).toBe(false);
});
it("tops up a short pointer press but stops a cancelled press immediately", () => {
  const input = new WalkInput(); render(<WalkControls input={input}/>);
  const button = screen.getByRole("button", { name: "Walk forward" }); button.setPointerCapture = vi.fn();
  const pointer = (type: string) => { const event = new Event(type, { bubbles: true }); Object.assign(event, { pointerId: 3, button: 0 }); fireEvent(button, event); };
  pointer("pointerdown"); expect(input.sample(0.01)("w")).toBe(1); pointer("pointerup"); pointer("lostpointercapture");
  let duration = 0.01; for (let i = 0; i < 30; i++) duration += input.sample(0.01)("w") * 0.01;
  expect(duration).toBeCloseTo(0.2); expect(input.active).toBe(false);
  pointer("pointerdown"); expect(input.active).toBe(true); pointer("pointercancel"); expect(input.active).toBe(false);
});
