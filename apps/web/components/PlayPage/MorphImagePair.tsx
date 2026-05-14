"use client";

import type { RefObject, TransitionEvent } from "react";

import type { MorphFx } from "@/hooks/useImageMorph";
import { inkMorphStyle } from "@/lib/morph-style";

interface Props {
  imgRef: RefObject<HTMLImageElement | null>;
  imageDataUrl: string;
  alt: string;
  morphFx: MorphFx | null;
  onError: () => void;
  /** Fired by the new image's transition-end so the page can clear morphFx + emit `morph:end`. */
  onMorphTransitionEnd: (e: TransitionEvent<HTMLImageElement>) => void;
  /** Visual hints derived from the page state — kept as plain strings to
   *  avoid pulling tier/phase types into the component. */
  newImageClassName: string;
}

/**
 * Two-layer morph rendering for the page image. Outgoing layer shimmers /
 * fades while the incoming layer ink-blooms outward from the click origin
 * via an animated radial mask (see `lib/morph-style.ts`).
 */
export function MorphImagePair({
  imgRef,
  imageDataUrl,
  alt,
  morphFx,
  onError,
  onMorphTransitionEnd,
  newImageClassName,
}: Props) {
  const newImageStyle = inkMorphStyle(morphFx);
  return (
    <>
      {/* Outgoing image. While morphFx is in `wait` (decode pending) the old
          image shimmers/blurs slightly so it reads as "transition in
          progress" instead of "stuck". Once the new image takes over, this
          layer fades out. */}
      {morphFx ? (
        <img
          src={morphFx.prevImg ?? imageDataUrl}
          alt=""
          aria-hidden
          className={
            "absolute inset-0 block h-full w-full object-contain select-none " +
            (morphFx.phase === "wait" && !morphFx.reduceMotion ? "ec-morph-old" : "")
          }
          style={{
            opacity: morphFx.phase === "reveal" ? 0 : 1,
            transition: "opacity 480ms cubic-bezier(0.22, 0.61, 0.36, 1)",
          }}
          draggable={false}
        />
      ) : null}
      <img
        ref={imgRef}
        src={morphFx?.nextImg ?? imageDataUrl}
        alt={alt}
        onError={onError}
        className={newImageClassName}
        style={newImageStyle}
        onTransitionEnd={onMorphTransitionEnd}
        draggable={false}
      />
    </>
  );
}
