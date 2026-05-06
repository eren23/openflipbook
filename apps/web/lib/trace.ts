export const TRACE_HEADER = "x-trace-id";

export function newTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `t-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function withTrace(init: RequestInit | undefined, traceId: string): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  headers.set(TRACE_HEADER, traceId);
  return { ...(init ?? {}), headers };
}

const lastTrace = { current: null as string | null };

export function setLastTrace(id: string): void {
  lastTrace.current = id;
  emit("trace:set", { id, ts: nowMs() });
}

export function getLastTrace(): string | null {
  return lastTrace.current;
}

export type HudEventName =
  | "trace:set"
  | "sse:status"
  | "sse:progress"
  | "sse:final"
  | "sse:error"
  | "image:decode"
  | "prefetch:hit"
  | "prefetch:miss"
  | "prefetch:inflight"
  | "precompute:candidates"
  | "morph:start"
  | "morph:end"
  | "react:commit";

type Listener = (payload: unknown) => void;

const listeners = new Map<HudEventName, Set<Listener>>();

export function on(name: HudEventName, cb: Listener): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

export function emit(name: HudEventName, payload: unknown): void {
  const set = listeners.get(name);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(payload);
    } catch {
      // listener errors must not break callers
    }
  }
}

export function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function mark(name: string): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  try {
    performance.mark(name);
  } catch {
    // ignore quota errors
  }
}

export function measure(name: string, startMark: string, endMark?: string): number | null {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return null;
  try {
    const m = performance.measure(name, startMark, endMark);
    return m.duration;
  } catch {
    return null;
  }
}
