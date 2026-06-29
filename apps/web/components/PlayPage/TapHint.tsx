"use client";

interface Props {
  /** The localised hint copy (i18n `tapHint`). */
  text: string;
}

/**
 * The "Tap anywhere on the image to explore" hint. A CENTERED, self-contained
 * pill at the bottom of the image — three properties matter and are pinned by
 * TapHint.test.tsx:
 *  - `pointer-events-none` so a tap on the bottom strip still explores the image
 *    instead of dying on the caption,
 *  - `justify-center` so it sits in the middle, clear of the bottom-corner
 *    buttons (📌 Pin style on the left, "localize now" on the right) that used to
 *    cover the old full-width left-aligned bar,
 *  - a truncating pill with its own background so it stays readable over any art.
 */
export function TapHint({ text }: Props) {
  return (
    <figcaption className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center text-sm text-white">
      <span className="max-w-[60%] truncate rounded-full bg-black/55 px-3 py-1 backdrop-blur">
        {text}
      </span>
    </figcaption>
  );
}
