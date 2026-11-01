import en from "./en.json" with { type: "json" };

export type Language =
  | "en"
  | "zh-Hans"
  | "zh-Hant"
  | "fr"
  | "es"
  | "es-AR"
  | "es-CL"
  | "pl"
  | "de"
  | "ru"
  | "ja"
  | "it"
  | "ca"
  | "sv-SE"
  | "ar"
  | "uk"
  | "ko"
  | "pt-BR"
  | "fa"
  | "nb-NO"
  | "el-GR"
  | "nl"
  | "cs"
  | "hu"
  | "sk"
  | "ro"
  | "hr"
  | "sr";

export type LanguageResource = typeof en;
type LazyLanguageResource = () => Promise<{
  default: Partial<LanguageResource>;
}>;

/**
 * Load the Dayjs locale together with the translated resource bundle.
 * Mantine Dates and Schedule format through Dayjs; loading only the JSON
 * resource would leave their visible dates and weekday names in English.
 */
function localizedResource(
  resource: LazyLanguageResource,
  dateLocale: () => Promise<unknown>,
): LazyLanguageResource {
  return async () => {
    const [loadedResource] = await Promise.all([resource(), dateLocale()]);
    return loadedResource;
  };
}

export const SUPPORTED_LANGUAGES: Record<
  Language,
  {
    name: string;
    originalName: string;
    flagEmoji: string;
    resource: LanguageResource | LazyLanguageResource;
  }
> = {
  en: {
    name: "English",
    originalName: "English",
    flagEmoji: "🇬🇧",
    resource: en,
  },
  ko: {
    name: "Korean (South Korea)",
    originalName: "한국어(대한민국)",
    flagEmoji: "🇰🇷",
    resource: localizedResource(
      () => import("./ko.json"),
      () => import("dayjs/locale/ko"),
    ),
  },
  "pt-BR": {
    name: "Portuguese (Brazil)",
    originalName: "português (Brasil)",
    flagEmoji: "🇧🇷",
    resource: localizedResource(
      () => import("./pt-BR.json"),
      () => import("dayjs/locale/pt-br"),
    ),
  },
  "zh-Hans": {
    name: "Simplified Chinese",
    originalName: "简体中文",
    flagEmoji: "🇨🇳",
    resource: localizedResource(
      () => import("./zh-Hans.json"),
      () => import("dayjs/locale/zh-cn"),
    ),
  },
  "zh-Hant": {
    name: "Traditional Chinese",
    originalName: "繁體中文",
    flagEmoji: "🇭🇰",
    resource: localizedResource(
      () => import("./zh-Hant.json"),
      () => import("dayjs/locale/zh-tw"),
    ),
  },
  fr: {
    name: "French",
    originalName: "français",
    flagEmoji: "🇫🇷",
    resource: localizedResource(
      () => import("./fr.json"),
      () => import("dayjs/locale/fr"),
    ),
  },
  es: {
    name: "Spanish",
    originalName: "español",
    flagEmoji: "🇪🇸",
    resource: localizedResource(
      () => import("./es.json"),
      () => import("dayjs/locale/es"),
    ),
  },
  "es-AR": {
    name: "Spanish (Argentina)",
    originalName: "español (Argentina)",
    flagEmoji: "🇦🇷",
    resource: localizedResource(
      () => import("./es-AR.json"),
      () => import("dayjs/locale/es"),
    ),
  },
  "es-CL": {
    name: "Spanish (Chile)",
    originalName: "español (Chile)",
    flagEmoji: "🇨🇱",
    resource: localizedResource(
      () => import("./es-CL.json"),
      () => import("dayjs/locale/es"),
    ),
  },
  pl: {
    name: "Polish",
    originalName: "Polski",
    flagEmoji: "🇵🇱",
    resource: localizedResource(
      () => import("./pl.json"),
      () => import("dayjs/locale/pl"),
    ),
  },
  de: {
    name: "German",
    originalName: "Deutsch",
    flagEmoji: "🇩🇪",
    resource: localizedResource(
      () => import("./de.json"),
      () => import("dayjs/locale/de"),
    ),
  },
  ru: {
    name: "Russian",
    originalName: "русский",
    flagEmoji: "🇷🇺",
    resource: localizedResource(
      () => import("./ru.json"),
      () => import("dayjs/locale/ru"),
    ),
  },
  ja: {
    name: "Japanese",
    originalName: "日本語",
    flagEmoji: "🇯🇵",
    resource: localizedResource(
      () => import("./ja.json"),
      () => import("dayjs/locale/ja"),
    ),
  },
  it: {
    name: "Italian",
    originalName: "italiano",
    flagEmoji: "🇮🇹",
    resource: localizedResource(
      () => import("./it.json"),
      () => import("dayjs/locale/it"),
    ),
  },
  ca: {
    name: "Catalan",
    originalName: "català",
    flagEmoji: "🇦🇩",
    resource: localizedResource(
      () => import("./ca.json"),
      () => import("dayjs/locale/ca"),
    ),
  },
  "sv-SE": {
    name: "Swedish (Sweden)",
    originalName: "svenska (Sverige)",
    flagEmoji: "🇸🇪",
    resource: localizedResource(
      () => import("./sv-SE.json"),
      () => import("dayjs/locale/sv"),
    ),
  },
  ar: {
    name: "Arabic",
    originalName: "العربية",
    flagEmoji: "🇸🇦",
    resource: localizedResource(
      () => import("./ar.json"),
      () => import("dayjs/locale/ar"),
    ),
  },
  fa: {
    name: "Persian",
    originalName: "فارسی",
    flagEmoji: "🇮🇷",
    resource: localizedResource(
      () => import("./fa.json"),
      () => import("dayjs/locale/fa"),
    ),
  },
  uk: {
    name: "Ukrainian",
    originalName: "українська",
    flagEmoji: "🇺🇦",
    resource: localizedResource(
      () => import("./uk.json"),
      () => import("dayjs/locale/uk"),
    ),
  },
  "nb-NO": {
    name: "Norwegian",
    originalName: "Norsk (Bokmål)",
    flagEmoji: "🇳🇴",
    resource: localizedResource(
      () => import("./nb-NO.json"),
      () => import("dayjs/locale/nb"),
    ),
  },
  "el-GR": {
    name: "Greek",
    originalName: "Ελληνικά",
    flagEmoji: "🇬🇷",
    resource: localizedResource(
      () => import("./el-GR.json"),
      () => import("dayjs/locale/el"),
    ),
  },
  nl: {
    name: "Dutch",
    originalName: "Nederlands",
    flagEmoji: "🇳🇱",
    resource: localizedResource(
      () => import("./nl.json"),
      () => import("dayjs/locale/nl"),
    ),
  },
  cs: {
    name: "Czech",
    originalName: "Čeština",
    flagEmoji: "🇨🇿",
    resource: localizedResource(
      () => import("./cs.json"),
      () => import("dayjs/locale/cs"),
    ),
  },
  hu: {
    name: "Hungarian",
    originalName: "magyar",
    flagEmoji: "🇭🇺",
    resource: localizedResource(
      () => import("./hu.json"),
      () => import("dayjs/locale/hu"),
    ),
  },
  sk: {
    name: "Slovak",
    originalName: "slovenčina",
    flagEmoji: "🇸🇰",
    resource: localizedResource(
      () => import("./sk.json"),
      () => import("dayjs/locale/sk"),
    ),
  },
  ro: {
    name: "Romanian",
    originalName: "română",
    flagEmoji: "🇷🇴",
    resource: localizedResource(
      () => import("./ro.json"),
      () => import("dayjs/locale/ro"),
    ),
  },
  hr: {
    name: "Croatian",
    originalName: "hrvatski",
    flagEmoji: "🇭🇷",
    resource: localizedResource(
      () => import("./hr.json"),
      () => import("dayjs/locale/hr"),
    ),
  },
  sr: {
    name: "Serbian (Latin)",
    originalName: "srpski (latinica)",
    flagEmoji: "🇷🇸",
    resource: localizedResource(
      () => import("./sr.json"),
      () => import("dayjs/locale/sr"),
    ),
  },
};

export const SUPPORTED_LANGUAGE_CODES = Object.keys(
  SUPPORTED_LANGUAGES,
) as Language[];

export const SUPPORTED_LANGUAGE_LABEL_KEY_PREFIX =
  "com.myoxus.locale.option." as const;

export const getSupportedLanguageLabelKey = (language: Language) =>
  `${SUPPORTED_LANGUAGE_LABEL_KEY_PREFIX}${language}` as const;

export const SUPPORTED_LANGUAGE_LABEL_KEYS = Object.fromEntries(
  SUPPORTED_LANGUAGE_CODES.map((language) => [
    language,
    getSupportedLanguageLabelKey(language),
  ]),
) as Record<Language, ReturnType<typeof getSupportedLanguageLabelKey>>;
