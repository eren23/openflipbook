"use client";

import type { ChangeEvent, FormEvent, RefObject } from "react";
import type { ImageTier } from "@openflipbook/config";

import { SUPPORTED_LOCALES, type SupportedLocale, type LocaleStrings } from "@/lib/i18n";
import { THEMES, type Theme } from "@/hooks/usePersistedTheme";

const TIERS: readonly ImageTier[] = ["fast", "balanced", "pro"] as const;

interface Props {
  t: LocaleStrings;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
  busy: boolean;
  outputLocale: SupportedLocale;
  setOutputLocale: (l: SupportedLocale) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  imageTier: ImageTier;
  setImageTier: (t: ImageTier) => void;
}

export function QueryToolbar({
  t,
  input,
  onInputChange,
  onSubmit,
  fileInputRef,
  onFileInputChange,
  busy,
  outputLocale,
  setOutputLocale,
  theme,
  setTheme,
  imageTier,
  setImageTier,
}: Props) {
  return (
    <>
      <form
        onSubmit={onSubmit}
        className="flex flex-wrap items-center gap-2 rounded-full border border-[var(--color-edge)] bg-[var(--color-canvas)]/80 px-4 py-2 shadow-sm"
      >
        <input
          autoFocus
          className="min-w-[8rem] flex-1 bg-transparent outline-none placeholder:opacity-60"
          placeholder={t.placeholder}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="rounded-full border border-[var(--color-edge)] px-3 py-1 text-xs hover:bg-[var(--color-ink)]/5 disabled:opacity-40"
          title="Upload an image as the starting page. Tap on it to explore regions."
        >
          {t.upload}
        </button>
        <select
          value={outputLocale}
          onChange={(e) => setOutputLocale(e.target.value as SupportedLocale)}
          disabled={busy}
          aria-label={t.langLabel}
          title={t.langLabel}
          className="rounded-full border border-[var(--color-edge)] bg-transparent px-2 py-1 text-xs disabled:opacity-40"
        >
          {SUPPORTED_LOCALES.map((loc) => (
            <option key={loc} value={loc}>
              {loc === "auto" ? t.langAuto : loc}
            </option>
          ))}
        </select>
        <div
          role="group"
          aria-label="Theme"
          className="flex items-center overflow-hidden rounded-full border border-[var(--color-edge)] text-xs"
          title="Theme — light / sepia / dark"
        >
          {THEMES.map((th) => (
            <button
              key={th}
              type="button"
              onClick={() => setTheme(th)}
              aria-pressed={theme === th}
              className={
                "px-2.5 py-1 transition-colors " +
                (theme === th
                  ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                  : "hover:bg-[var(--color-ink)]/5")
              }
            >
              {th === "light"
                ? t.themeLight
                : th === "sepia"
                  ? t.themeSepia
                  : t.themeDark}
            </button>
          ))}
        </div>
        <div
          role="group"
          aria-label="Image quality tier"
          className="flex items-center overflow-hidden rounded-full border border-[var(--color-edge)] text-xs"
          title="Image quality tier — fast (cheap), balanced (default), pro (premium)"
        >
          <span className="px-2 py-1 opacity-60">image</span>
          {TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setImageTier(tier)}
              disabled={busy}
              aria-pressed={imageTier === tier}
              className={
                "px-2.5 py-1 transition-colors disabled:opacity-40 " +
                (imageTier === tier
                  ? "bg-[var(--color-ink)] text-[var(--color-canvas)]"
                  : "hover:bg-[var(--color-ink)]/5")
              }
            >
              {tier}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          className="rounded-full bg-[var(--color-ink)] px-4 py-1 text-[var(--color-canvas)] disabled:opacity-40"
        >
          {busy ? t.generating : t.go}
        </button>
      </form>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFileInputChange}
      />
    </>
  );
}
