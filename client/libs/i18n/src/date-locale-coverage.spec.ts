import dayjs from "dayjs";
import { describe, expect, test } from "vitest";

import { type Language, SUPPORTED_LANGUAGES } from "./resources";

const DAYJS_LOCALE_BY_LANGUAGE: Record<Exclude<Language, "en">, string> = {
  ar: "ar",
  ca: "ca",
  cs: "cs",
  de: "de",
  "el-GR": "el",
  es: "es",
  "es-AR": "es",
  "es-CL": "es",
  fa: "fa",
  fr: "fr",
  hr: "hr",
  hu: "hu",
  it: "it",
  ja: "ja",
  ko: "ko",
  "nb-NO": "nb",
  nl: "nl",
  pl: "pl",
  "pt-BR": "pt-br",
  ro: "ro",
  ru: "ru",
  sk: "sk",
  sr: "sr",
  "sv-SE": "sv",
  uk: "uk",
  "zh-Hans": "zh-cn",
  "zh-Hant": "zh-tw",
};

describe("Mantine date locale coverage", () => {
  test.each(Object.entries(DAYJS_LOCALE_BY_LANGUAGE))(
    "%s resource loader registers Dayjs locale %s",
    async (language, expectedLocale) => {
      const resource = SUPPORTED_LANGUAGES[language as Language].resource;
      expect(typeof resource).toBe("function");
      if (typeof resource !== "function") {
        throw new Error(`${language} does not use a lazy locale resource`);
      }
      await resource();

      // Without the paired Dayjs import, Mantine Dates silently falls back to
      // English even though the translated Myoxus resource loaded correctly.
      expect(dayjs().locale(expectedLocale).locale()).toBe(expectedLocale);
    },
  );
});
