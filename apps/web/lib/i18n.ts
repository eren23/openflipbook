/**
 * Tiny UI-string localization for the most visible chrome. Content (page
 * titles, in-image labels, click subjects) is localized server-side via the
 * `output_locale` body field on /sse/generate; this file only handles the
 * static UI text around the canvas.
 *
 * Adding a locale: drop a new entry below. Falls back to `en` for any
 * missing key. Keep keys short and stable.
 */

export type LocaleStrings = {
  placeholder: string;
  upload: string;
  go: string;
  generating: string;
  animateClip: string;
  animateStream: string;
  animateStop: string;
  generatingClip: string;
  edit: string;
  cancelEdit: string;
  apply: string;
  editPlaceholder: string;
  tapHint: string;
  langLabel: string;
  langAuto: string;
  themeLight: string;
  themeSepia: string;
  themeDark: string;
};

const en: LocaleStrings = {
  placeholder: "Ask about anything, or upload a seed image…",
  upload: "⬆ Upload",
  go: "Go",
  generating: "…",
  animateClip: "Animate (5s clip)",
  animateStream: "Animate (stream)",
  animateStop: "Stop",
  generatingClip: "Generating clip…",
  edit: "✎ Edit",
  cancelEdit: "✕ Cancel edit",
  apply: "Apply",
  editPlaceholder: "Describe how to change this image…",
  tapHint: "Tap anywhere on the image to explore.",
  langLabel: "Output language",
  langAuto: "auto",
  themeLight: "light",
  themeSepia: "sepia",
  themeDark: "dark",
};

const STRINGS: Record<string, Partial<LocaleStrings>> = {
  en,
  es: {
    placeholder: "Pregunta cualquier cosa o sube una imagen base…",
    upload: "⬆ Subir",
    go: "Ir",
    animateClip: "Animar (5s)",
    animateStream: "Animar (stream)",
    animateStop: "Detener",
    generatingClip: "Generando clip…",
    edit: "✎ Editar",
    cancelEdit: "✕ Cancelar edición",
    apply: "Aplicar",
    editPlaceholder: "Describe cómo modificar esta imagen…",
    tapHint: "Toca la imagen para explorar.",
    langLabel: "Idioma de salida",
    langAuto: "auto",
    themeLight: "claro",
    themeSepia: "sepia",
    themeDark: "oscuro",
  },
  fr: {
    placeholder: "Posez une question ou déposez une image…",
    upload: "⬆ Importer",
    go: "Aller",
    animateClip: "Animer (5s)",
    animateStream: "Animer (stream)",
    animateStop: "Arrêter",
    generatingClip: "Génération du clip…",
    edit: "✎ Modifier",
    cancelEdit: "✕ Annuler",
    apply: "Appliquer",
    editPlaceholder: "Décrivez comment modifier cette image…",
    tapHint: "Touchez l'image pour explorer.",
    langLabel: "Langue de sortie",
    langAuto: "auto",
    themeLight: "clair",
    themeSepia: "sépia",
    themeDark: "sombre",
  },
  de: {
    placeholder: "Frag etwas oder lade ein Startbild hoch…",
    upload: "⬆ Hochladen",
    go: "Los",
    animateClip: "Animieren (5s)",
    animateStream: "Animieren (Stream)",
    animateStop: "Stopp",
    generatingClip: "Erzeuge Clip…",
    edit: "✎ Bearbeiten",
    cancelEdit: "✕ Abbrechen",
    apply: "Anwenden",
    editPlaceholder: "Beschreibe die Änderung…",
    tapHint: "Tippe ins Bild, um zu erkunden.",
    langLabel: "Ausgabesprache",
    langAuto: "auto",
    themeLight: "hell",
    themeSepia: "sepia",
    themeDark: "dunkel",
  },
  tr: {
    placeholder: "Bir şey sor veya başlangıç görseli yükle…",
    upload: "⬆ Yükle",
    go: "Git",
    animateClip: "Animasyon (5s)",
    animateStream: "Animasyon (akış)",
    animateStop: "Durdur",
    generatingClip: "Klip oluşturuluyor…",
    edit: "✎ Düzenle",
    cancelEdit: "✕ İptal",
    apply: "Uygula",
    editPlaceholder: "Bu görseli nasıl değiştireceğini anlat…",
    tapHint: "Keşfetmek için görsele dokun.",
    langLabel: "Çıktı dili",
    langAuto: "oto",
    themeLight: "açık",
    themeSepia: "sepya",
    themeDark: "koyu",
  },
  ja: {
    placeholder: "質問するか、種となる画像をアップロード…",
    upload: "⬆ アップロード",
    go: "実行",
    animateClip: "アニメ化 (5s)",
    animateStream: "アニメ化 (ストリーム)",
    animateStop: "停止",
    generatingClip: "クリップ生成中…",
    edit: "✎ 編集",
    cancelEdit: "✕ キャンセル",
    apply: "適用",
    editPlaceholder: "この画像をどう変えるか説明…",
    tapHint: "画像をタップして探索。",
    langLabel: "出力言語",
    langAuto: "自動",
    themeLight: "ライト",
    themeSepia: "セピア",
    themeDark: "ダーク",
  },
  zh: {
    placeholder: "提问，或上传一张种子图片…",
    upload: "⬆ 上传",
    go: "开始",
    animateClip: "动画 (5秒)",
    animateStream: "动画 (流式)",
    animateStop: "停止",
    generatingClip: "正在生成片段…",
    edit: "✎ 编辑",
    cancelEdit: "✕ 取消",
    apply: "应用",
    editPlaceholder: "描述如何修改这张图…",
    tapHint: "点击图片继续探索。",
    langLabel: "输出语言",
    langAuto: "自动",
    themeLight: "亮",
    themeSepia: "复古",
    themeDark: "暗",
  },
  ar: {
    placeholder: "اسأل أي شيء أو ارفع صورة بداية…",
    upload: "⬆ رفع",
    go: "ابدأ",
    animateClip: "تحريك (٥ث)",
    animateStream: "تحريك (بث)",
    animateStop: "إيقاف",
    generatingClip: "جارٍ توليد المقطع…",
    edit: "✎ تعديل",
    cancelEdit: "✕ إلغاء",
    apply: "تطبيق",
    editPlaceholder: "صف كيف تعدل هذه الصورة…",
    tapHint: "انقر على الصورة للاستكشاف.",
    langLabel: "لغة الإخراج",
    langAuto: "تلقائي",
    themeLight: "فاتح",
    themeSepia: "سيبيا",
    themeDark: "داكن",
  },
};

export const SUPPORTED_LOCALES = [
  "auto",
  "en",
  "es",
  "fr",
  "de",
  "tr",
  "ja",
  "zh",
  "ar",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const RTL_LOCALES = new Set(["ar", "he", "fa", "ur"]);

function shortTag(locale: string): string {
  const head = locale.split("-")[0] ?? "en";
  return head.toLowerCase();
}

export function isRTL(locale: string): boolean {
  return RTL_LOCALES.has(shortTag(locale));
}

export function detectLocale(): SupportedLocale {
  if (typeof navigator === "undefined") return "auto";
  const short = shortTag(navigator.language || "en");
  return (SUPPORTED_LOCALES as readonly string[]).includes(short)
    ? (short as SupportedLocale)
    : "auto";
}

/**
 * Resolve the user-facing locale → string table. `auto` defers to the
 * browser; falls back to English for unknown short tags or missing keys.
 */
export function getStrings(locale: string): LocaleStrings {
  let key = shortTag(locale);
  if (key === "auto") {
    key =
      typeof navigator !== "undefined"
        ? shortTag(navigator.language || "en")
        : "en";
  }
  const table = STRINGS[key] ?? {};
  return { ...en, ...table };
}

/**
 * Convert the UI selector value (which may be "auto") into the BCP-47 short
 * tag the backend prompts on. `auto` resolves at call time.
 */
export function resolveOutputLocale(uiLocale: string): string {
  if (uiLocale === "auto") {
    return typeof navigator !== "undefined"
      ? shortTag(navigator.language || "en")
      : "en";
  }
  return uiLocale;
}
