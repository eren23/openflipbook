// Two-layer morph rendering: single-img rest state, the dive vs shimmer wait
// classes, the --ec-dive-scale contract (motion end == zoom-continuation
// start), the reduce-motion opacity branch, and the event wiring.
import { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MorphFx } from "@/hooks/useImageMorph";
import { DIVE_END_SCALE } from "@/lib/morph-style";

import { MorphImagePair } from "./MorphImagePair";

function fx(over: Partial<MorphFx> = {}): MorphFx {
  return {
    ox: 40,
    oy: 30,
    prevImg: "data:image/jpeg;base64,prev",
    nextImg: "data:image/jpeg;base64,next",
    phase: "wait",
    isFinal: false,
    startedAt: 0,
    reduceMotion: false,
    ...over,
  };
}

function mount(morphFx: MorphFx | null, over: Partial<Parameters<typeof MorphImagePair>[0]> = {}) {
  const props = {
    imgRef: createRef<HTMLImageElement | null>(),
    imageDataUrl: "data:image/jpeg;base64,current",
    alt: "the page",
    morphFx,
    onError: vi.fn(),
    onMorphTransitionEnd: vi.fn(),
    newImageClassName: "the-new-image",
    ...over,
  };
  const view = render(<MorphImagePair {...props} />);
  const imgs = Array.from(view.container.querySelectorAll("img"));
  return { props, view, imgs };
}

describe("MorphImagePair", () => {
  it("rest state: one image, no morph style, ref attached", () => {
    const { props, imgs } = mount(null);
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.getAttribute("src")).toBe("data:image/jpeg;base64,current");
    expect(imgs[0]!.getAttribute("alt")).toBe("the page");
    expect(imgs[0]!.getAttribute("style")).toBeFalsy();
    expect(props.imgRef.current).toBe(imgs[0]);
  });

  it("morphing renders old (prevImg, decorative) under new (nextImg)", () => {
    const { imgs } = mount(fx());
    expect(imgs.length).toBe(2);
    const [oldImg, newImg] = imgs as [HTMLImageElement, HTMLImageElement];
    expect(oldImg.getAttribute("src")).toBe("data:image/jpeg;base64,prev");
    expect(oldImg.getAttribute("aria-hidden")).toBe("true");
    expect(oldImg.getAttribute("alt")).toBe("");
    expect(newImg.getAttribute("src")).toBe("data:image/jpeg;base64,next");
    expect(newImg.className).toBe("the-new-image");
  });

  it("dive-wait: old layer gets the dive class, origin at the tap, scale var = 1/REGION_FRAC", () => {
    const { imgs } = mount(fx({ dive: true }));
    const oldImg = imgs[0]!;
    expect(oldImg.className).toContain("ec-morph-old");
    expect(oldImg.className).not.toContain("ec-morph-shimmer");
    expect(oldImg.style.transformOrigin).toBe("40px 30px");
    // The single TS source of truth for the dive's end scale.
    expect(oldImg.style.getPropertyValue("--ec-dive-scale")).toBe(String(DIVE_END_SCALE));
  });

  it("non-dive wait shimmers instead — the motion never promises a zoom", () => {
    const { imgs } = mount(fx({ dive: false }));
    expect(imgs[0]!.className).toContain("ec-morph-shimmer");
    expect(imgs[0]!.className).not.toContain("ec-morph-old");
  });

  it("reveal phase fades the old layer out", () => {
    const { imgs } = mount(fx({ phase: "reveal", dive: true }));
    const oldImg = imgs[0]!;
    expect(oldImg.style.opacity).toBe("0");
    // Reveal is past the wait: no dive/shimmer class riding along.
    expect(oldImg.className).not.toContain("ec-morph-old");
  });

  it("reduce-motion: no dive/shimmer, new image gets the plain opacity fade", () => {
    const { imgs } = mount(fx({ dive: true, reduceMotion: true }));
    const [oldImg, newImg] = imgs as [HTMLImageElement, HTMLImageElement];
    expect(oldImg.className).not.toContain("ec-morph-old");
    expect(oldImg.className).not.toContain("ec-morph-shimmer");
    expect(newImg.style.transition).toBe("opacity 200ms linear");
  });

  it("full motion animates the mask, not opacity, on the new image", () => {
    // happy-dom drops mask-* declarations from inline style, so pin the branch
    // through what it keeps: the transition targets mask-size (the ink bloom).
    // The mask geometry itself is covered by lib/morph-style.test.ts.
    const { imgs } = mount(fx());
    expect(imgs[1]!.style.transition).toContain("mask-size");
    expect(imgs[1]!.style.transition).not.toContain("opacity");
  });

  it("centre-origin fallback when the fx has no numeric origin", () => {
    const { imgs } = mount(fx({ ox: undefined as unknown as number, dive: true }));
    expect(imgs[0]!.style.transformOrigin).toBe("center");
  });

  it("wires onError and onTransitionEnd to the live image", () => {
    const { props, imgs } = mount(fx());
    fireEvent.error(imgs[1]!);
    expect(props.onError).toHaveBeenCalledTimes(1);
    fireEvent.transitionEnd(imgs[1]!);
    expect(props.onMorphTransitionEnd).toHaveBeenCalledTimes(1);
  });

  it("missing prev/next fall back to the current page image", () => {
    const { imgs } = mount(fx({ prevImg: null, nextImg: null }));
    expect(imgs[0]!.getAttribute("src")).toBe("data:image/jpeg;base64,current");
    expect(imgs[1]!.getAttribute("src")).toBe("data:image/jpeg;base64,current");
  });
});
