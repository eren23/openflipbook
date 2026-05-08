"use client";

/**
 * Shown when the rendered <img> fires `onError`. Most common cause: a
 * permalink-replayed page whose R2 link expired (or the bucket's
 * public-access toggle got flipped off). The user just needs to start
 * a fresh query.
 */
export function ImageFailedOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/70 p-6 text-center text-white">
      <div className="max-w-md text-sm leading-relaxed">
        Couldn&apos;t load this page&apos;s image. The persisted R2 link may have expired or the
        bucket&apos;s public access is off. Type a new query above and hit Go to start fresh.
      </div>
    </div>
  );
}
