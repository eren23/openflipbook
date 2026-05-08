import { afterEach, describe, expect, it, vi } from "vitest";

import { detectLocale, getStrings, isRTL, resolveOutputLocale, SUPPORTED_LOCALES } from "./i18n";

function withNavigatorLanguage<T>(lang: string | undefined, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(navigator, "language");
  Object.defineProperty(navigator, "language", {
    value: lang ?? "",
    configurable: true,
  });
  try {
    return fn();
  } finally {
    if (orig) Object.defineProperty(navigator, "language", orig);
  }
}

describe("isRTL", () => {
  it("flags RTL short tags", () => {
    expect(isRTL("ar")).toBe(true);
    expect(isRTL("ar-EG")).toBe(true);
    expect(isRTL("he")).toBe(true);
  });
  it("rejects LTR tags", () => {
    expect(isRTL("en-US")).toBe(false);
    expect(isRTL("ja")).toBe(false);
  });
});

describe("detectLocale", () => {
  it("returns supported short tag from navigator", () => {
    withNavigatorLanguage("fr-CA", () => {
      expect(detectLocale()).toBe("fr");
    });
  });
  it("falls back to auto for unsupported locales", () => {
    withNavigatorLanguage("xx-YY", () => {
      expect(detectLocale()).toBe("auto");
    });
  });
});

describe("getStrings", () => {
  it("falls back to English for missing keys", () => {
    const fr = getStrings("fr");
    // 'generating' is only defined in `en`; every other locale falls back.
    expect(fr.generating).toBe("…");
    expect(fr.go).toBe("Aller");
  });
  it("resolves auto via navigator", () => {
    withNavigatorLanguage("ja-JP", () => {
      const s = getStrings("auto");
      expect(s.upload).toContain("アップロード");
    });
  });
  it("returns English for an unknown locale", () => {
    const en = getStrings("xx");
    expect(en.go).toBe("Go");
  });
});

describe("resolveOutputLocale", () => {
  it("returns explicit locale unchanged", () => {
    expect(resolveOutputLocale("es")).toBe("es");
  });
  it("auto resolves to navigator short tag", () => {
    withNavigatorLanguage("de-AT", () => {
      expect(resolveOutputLocale("auto")).toBe("de");
    });
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("contains 'auto' and 'en'", () => {
    expect(SUPPORTED_LOCALES).toContain("auto");
    expect(SUPPORTED_LOCALES).toContain("en");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
