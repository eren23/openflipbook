"use client";

import { useEffect, useState, type RefObject } from "react";

import { objectContainRect, type ContainRect } from "@/lib/image-click";

/**
 * Track the on-screen rectangle an `object-fit: contain` <img> content occupies
 * inside its element. Overlays use this to place image-space (0..1) boxes onto
 * the *letterboxed content*, not the wrapper, so a non-16:9 upload (which
 * pillar/letterboxes inside the 16:9 figure) stays aligned.
 *
 * Re-measures on element resize and on image load. Returns null until the image
 * has natural dimensions (callers fall back to wrapper-relative %).
 */
export function useContainRect(
  imgRef?: RefObject<HTMLImageElement | null>
): ContainRect | null {
  const [rect, setRect] = useState<ContainRect | null>(null);
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let attached: HTMLImageElement | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const measure = () => {
      const img = attached;
      if (!img) return;
      setRect(
        objectContainRect(
          img.clientWidth,
          img.clientHeight,
          img.naturalWidth,
          img.naturalHeight
        )
      );
    };
    const attach = (img: HTMLImageElement) => {
      attached = img;
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(img);
      img.addEventListener("load", measure);
    };
    const img = imgRef?.current;
    if (img) {
      attach(img);
    } else {
      // Callers above the conditional <figure> mount BEFORE any image exists
      // (the play page itself, hydrating a continue-session): a one-shot
      // effect would bail here and never measure — the invisible-marquee bug.
      // Poll until the element appears, then attach for real.
      poll = setInterval(() => {
        const found = imgRef?.current;
        if (found) {
          if (poll) clearInterval(poll);
          poll = null;
          attach(found);
        }
      }, 300);
    }
    return () => {
      if (poll) clearInterval(poll);
      ro?.disconnect();
      attached?.removeEventListener("load", measure);
    };
  }, [imgRef]);
  return rect;
}
