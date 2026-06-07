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
    const img = imgRef?.current;
    if (!img) return;
    const measure = () => {
      setRect(
        objectContainRect(
          img.clientWidth,
          img.clientHeight,
          img.naturalWidth,
          img.naturalHeight
        )
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    img.addEventListener("load", measure);
    return () => {
      ro.disconnect();
      img.removeEventListener("load", measure);
    };
  }, [imgRef]);
  return rect;
}
