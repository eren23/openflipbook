interface FrameSample { time: number; interval: number; cpu: number; rendered: boolean }
const rounded = (value: number) => Math.round(value * 100) / 100;
const percentile = (sorted: number[], quantile: number) => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;

// Five seconds / at most 600 frames. Excludes startup and hidden-tab pauses;
// CPU submission time is deliberately not labeled GPU or presented-frame time.
export class ViewportPerformance {
  private samples: FrameSample[] = [];
  private start: number | null = null;
  private last: number | null = null;
  private published = 0;
  reset() { this.samples = []; this.start = null; this.last = null; this.published = 0; }
  record(now: number, cpu: number, rendered: boolean, visible = true) {
    if (!visible) { this.reset(); return null; }
    if (!Number.isFinite(now) || !Number.isFinite(cpu) || cpu < 0) return null;
    if (this.last === null || now <= this.last) {
      this.reset(); this.start = now; this.last = now; this.published = now; return null;
    }
    const interval = now - this.last; this.last = now;
    if (now - this.start! < 500) return null;
    this.samples.push({ time: now, interval, cpu, rendered });
    while (this.samples.length > 600 || this.samples[0]!.time < now - 5000) this.samples.shift();
    if (now - this.published < 1000 || this.samples.length < 2) return null;
    this.published = now;
    const intervals = this.samples.map(s => s.interval).sort((a, b) => a - b);
    const work = this.samples.map(s => s.cpu).sort((a, b) => a - b);
    return { version: 1, samples: this.samples.length,
      window_ms: rounded(this.samples.reduce((sum, s) => sum + s.interval, 0)),
      rendered_frames: this.samples.filter(s => s.rendered).length,
      interval_ms: { p50: rounded(percentile(intervals, 0.5)), p95: rounded(percentile(intervals, 0.95)), p99: rounded(percentile(intervals, 0.99)), max: rounded(intervals.at(-1)!) },
      cpu_ms: { p50: rounded(percentile(work, 0.5)), p95: rounded(percentile(work, 0.95)), max: rounded(work.at(-1)!) },
      frames_over_33ms: this.samples.filter(s => s.interval > 1000 / 30).length };
  }
}
