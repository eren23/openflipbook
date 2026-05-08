"use client";

import { useEffect, useRef, useState } from "react";

import { SUPPORTED_LOCALES, type SupportedLocale, isRTL, resolveOutputLocale } from "@/lib/i18n";

const KEY = "openflipbook.outputLocale";

/**
 * Output-locale preference persisted to localStorage. As a side effect of
 * setting the locale, also pushes the resolved BCP-47 short tag onto
 * `<html lang>` and toggles `dir=rtl` for RTL locales — that's the chrome
 * direction the app cares about.
 */
export function usePersistedLocale(): readonly [SupportedLocale, (l: SupportedLocale) => void] {
  const [locale, setLocale] = useState<SupportedLocale>("auto");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(KEY);
    if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
      setLocale(stored as SupportedLocale);
    }
  }, []);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.localStorage.setItem(KEY, locale);
    const head = resolveOutputLocale(locale);
    document.documentElement.setAttribute("lang", head);
    document.documentElement.setAttribute("dir", isRTL(head) ? "rtl" : "ltr");
  }, [locale]);

  return [locale, setLocale] as const;
}
