"use client";

import { useCallback, useEffect, useRef } from "react";

export const ANIMATION_TIMEOUT_MS = 180_000;

interface AnimationCallbacks {
  onStart(): void;
  onReady(url: string): void;
  onError(message: string): void;
}
interface ActiveClip {
  controller: AbortController;
  binding: string;
  timer: ReturnType<typeof setTimeout>;
  timedOut: boolean;
}

/** One foreground animation, bound to the page whose pixels it animates.
 * A transport can resolve after abort; request identity still fences every
 * UI update. Cancellation also settles the caller when a transport hangs. */
export function useAnimationClip(binding: string, callbacks: AnimationCallbacks) {
  const active = useRef<ActiveClip | null>(null);
  const currentBinding = useRef(binding), handlers = useRef(callbacks), mounted = useRef(true);
  currentBinding.current = binding;
  handlers.current = callbacks;

  const cancel = useCallback(() => {
    const previous = active.current;
    active.current = null;
    if (previous) { clearTimeout(previous.timer); previous.controller.abort(); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [binding, cancel]);

  const request = useCallback(async (body: Record<string, unknown>): Promise<string | null> => {
    if (!mounted.current || currentBinding.current !== binding) return null;
    cancel();
    const controller = new AbortController();
    const clip: ActiveClip = { controller, binding, timedOut: false,
      timer: setTimeout(() => { clip.timedOut = true; controller.abort(); }, ANIMATION_TIMEOUT_MS) };
    active.current = clip;
    const current = () => mounted.current && active.current === clip && currentBinding.current === clip.binding;
    handlers.current.onStart();
    let aborted!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      aborted = () => reject(new DOMException("Animation cancelled", "AbortError"));
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    try {
      const result = await Promise.race([cancelled, (async () => {
        const response = await fetch("/api/animate", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body), signal: controller.signal });
        const data = await response.json() as { video_url?: unknown; error?: string };
        if (!response.ok || typeof data.video_url !== "string" || !data.video_url)
          throw new Error(data.error || `HTTP ${response.status}`);
        return data.video_url;
      })()]);
      if (!current() || controller.signal.aborted) return null;
      handlers.current.onReady(result);
      return result;
    } catch (error) {
      if (current()) {
        if (clip.timedOut) handlers.current.onError("Animate timed out after 3 minutes. Try again or stop.");
        else if (!controller.signal.aborted) handlers.current.onError(error instanceof Error ? error.message : String(error));
      }
      return null;
    } finally {
      clearTimeout(clip.timer);
      controller.signal.removeEventListener("abort", aborted);
      if (active.current === clip) active.current = null;
    }
  }, [binding, cancel]);
  return { request, cancel };
}
