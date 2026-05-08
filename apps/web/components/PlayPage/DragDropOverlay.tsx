"use client";

/**
 * Full-screen "drop here" hint shown while the user is dragging a file
 * over the page. Pure visual; the parent listens for dragenter/leave/drop
 * to toggle visibility.
 */
export function DragDropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/40 text-center text-lg text-white">
      <div className="rounded-2xl border-2 border-dashed border-white/80 px-10 py-8">
        Drop an image to start from it
      </div>
    </div>
  );
}
