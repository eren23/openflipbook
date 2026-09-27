import { expect, it } from "vitest";
import { ViewportPerformance } from "./viewport-performance";

it("measures unclamped frame intervals separately from CPU work and renders", () => {
  const stats = new ViewportPerformance(); let report;
  for (let time = 0; time <= 6000; time += 20) report = stats.record(time, 3, time % 40 === 0) ?? report;
  expect(report).toMatchObject({ version: 1, rendered_frames: 126,
    interval_ms: { p50: 20, p95: 20, p99: 20, max: 20 }, cpu_ms: { p50: 3, p95: 3, max: 3 }, frames_over_33ms: 0 });
});
it("retains long frame evidence instead of hiding it with the physics dt clamp", () => {
  const stats = new ViewportPerformance();
  for (let time = 0; time <= 1000; time += 20) stats.record(time, 1, true);
  const report = stats.record(2000, 150, true);
  expect(report?.interval_ms.max).toBe(1000); expect(report?.frames_over_33ms).toBe(1);
  expect(report?.cpu_ms.max).toBe(150);
});
it("resets warmup after hidden tabs, clock discontinuity and explicit teardown", () => {
  const stats = new ViewportPerformance();
  for (let time = 0; time <= 1000; time += 20) stats.record(time, 1, true);
  expect(stats.record(8000, 0, false, false)).toBeNull();
  expect(stats.record(10000, 1, true)).toBeNull();
  let report;
  for (let time = 10020; time <= 11000; time += 20) report = stats.record(time, 1, true) ?? report;
  expect(report?.interval_ms.max).toBe(20);
  expect(stats.record(1, 1, true)).toBeNull();
  stats.reset(); expect(stats.record(50000, 1, true)).toBeNull();
});
it("bounds high refresh-rate memory and rejects invalid timings", () => {
  const stats = new ViewportPerformance(); let report;
  for (let time = 0; time <= 6000; time += 1) report = stats.record(time, 0.1, true) ?? report;
  expect(report?.samples).toBe(600);
  expect(stats.record(NaN, 1, true)).toBeNull(); expect(stats.record(7000, Infinity, true)).toBeNull();
});
