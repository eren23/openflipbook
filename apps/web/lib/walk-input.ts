export const WALK_KEYS = ["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type WalkKey = typeof WALK_KEYS[number];
export const walkTapSeconds = (key: WalkKey) => key === "ArrowLeft" || key === "ArrowRight" ? Math.PI / 18 : 0.2;
export function walkKey(value: string): WalkKey | null {
  const key = value.length === 1 ? value.toLowerCase() : value;
  return WALK_KEYS.includes(key as WalkKey) ? key as WalkKey : null;
}

// Short actions and held controls share the ordinary physics movement loop.
// Sources are independent so releasing a touch cannot release a held key.
export class WalkInput {
  private holds = new Map<string, { key: WalkKey; elapsed: number }>();
  private pulses = new Map<WalkKey, number>();
  get active() { return this.holds.size > 0 || this.pulses.size > 0; }
  hold(key: WalkKey, source: string) {
    if (!this.holds.has(source)) this.holds.set(source, { key, elapsed: 0 });
  }
  release(source: string, minimum = 0) {
    const held = this.holds.get(source);
    this.holds.delete(source);
    if (held && minimum > held.elapsed) this.tap(held.key, minimum - held.elapsed);
  }
  tap(key: WalkKey, seconds = walkTapSeconds(key)) {
    if (Number.isFinite(seconds) && seconds > 0) this.pulses.set(key, Math.min(0.4, (this.pulses.get(key) ?? 0) + seconds));
  }
  clear() { this.holds.clear(); this.pulses.clear(); }
  sample(dt: number) {
    const values = new Map<WalkKey, number>();
    if (!(dt > 0) || !Number.isFinite(dt)) return (_key: WalkKey) => 0;
    for (const held of this.holds.values()) { held.elapsed += dt; values.set(held.key, 1); }
    for (const [key, remaining] of this.pulses) {
      values.set(key, Math.max(values.get(key) ?? 0, Math.min(1, remaining / dt)));
      if (remaining <= dt + 1e-9) this.pulses.delete(key); else this.pulses.set(key, remaining - dt);
    }
    return (key: WalkKey) => values.get(key) ?? 0;
  }
}
