"use client";

import { SUPPORTED_LOCALES, type SupportedLocale, isRTL, resolveOutputLocale } from "@/lib/i18n";

import { usePersistedState } from "./usePersistedState";

const KEY = "openflipbook.outputLocale";

function isLocale(v: unknown): v is SupportedLocale {
  return typeof v === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/**
 * Output-locale preference persisted to localStorage. As a side effect of
 * setting the locale, also pushes the resolved BCP-47 short tag onto
 * `<html lang>` and toggles `dir=rtl` for RTL locales — that's the chrome
 * direction the app cares about.
 */
export function usePersistedLocale(): readonly [SupportedLocale, (l: SupportedLocale) => void] {
  return usePersistedState<SupportedLocale>(KEY, "auto", isLocale, (l) => {
    const head = resolveOutputLocale(l);
    document.documentElement.setAttribute("lang", head);
    document.documentElement.setAttribute("dir", isRTL(head) ? "rtl" : "ltr");
  });
}
