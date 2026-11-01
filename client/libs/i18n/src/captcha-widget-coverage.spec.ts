/**
 * Captcha coverage is required in EN/DE/FR/ES. Existing optional translations
 * must still be native text rather than copied English fallback values.
 */
import { describe, expect, test } from "vitest";

import { SUPPORTED_LANGUAGES } from "./resources";
import en from "./resources/en.json";

const CAPTCHA_WIDGET_KEYS = [
  "com.myoxus.captcha.widget.ariaLinkLabel",
  "com.myoxus.captcha.widget.cancel",
  "com.myoxus.captcha.widget.enterCode",
  "com.myoxus.captcha.widget.enterCodeAria",
  "com.myoxus.captcha.widget.enterCodeFromImage",
  "com.myoxus.captcha.widget.error",
  "com.myoxus.captcha.widget.expired",
  "com.myoxus.captcha.widget.getAudioChallenge",
  "com.myoxus.captcha.widget.label",
  "com.myoxus.captcha.widget.loading",
  "com.myoxus.captcha.widget.reload",
  "com.myoxus.captcha.widget.verificationRequired",
  "com.myoxus.captcha.widget.verified",
  "com.myoxus.captcha.widget.verify",
  "com.myoxus.captcha.widget.verifying",
  "com.myoxus.captcha.widget.waitAlert",
] as const;

const enDict = en as Record<string, string>;

// Exercise the same registry loaders used by production. This keeps the gate
// executable in both Vite and the matrix's direct Vitest environment.
const loadLocale = async (code: string): Promise<Record<string, string>> => {
  const entry = SUPPORTED_LANGUAGES[code as keyof typeof SUPPORTED_LANGUAGES];
  if (!entry) throw new Error(`no registered locale ${code}`);
  const resource =
    typeof entry.resource === "function"
      ? (await entry.resource()).default
      : entry.resource;
  return resource as Record<string, string>;
};

const registeredCodes = Object.keys(SUPPORTED_LANGUAGES);

describe("INV-CAPTCHA-WIDGET-COVERAGE-1: all 16 captcha keys present in main languages", () => {
  test.each(["en", "de", "fr", "es"])(
    "%s has all captcha-widget keys",
    async (code) => {
      const dict = await loadLocale(code);
      const missing = CAPTCHA_WIDGET_KEYS.filter((k) => !(k in dict));
      expect(
        missing,
        `${code} is missing captcha keys: ${missing.join(", ")}`,
      ).toEqual([]);
    },
  );
});

describe("INV-CAPTCHA-WIDGET-COVERAGE-2: translated values diverge from English", () => {
  const translatedCodes = registeredCodes.filter((c) => c !== "en");
  test.each(translatedCodes)(
    "%s captcha keys are not English fallbacks",
    async (code) => {
      const dict = await loadLocale(code);
      const fallbacks = CAPTCHA_WIDGET_KEYS.filter(
        (k) => k in dict && dict[k] === enDict[k],
      );
      expect(
        fallbacks,
        `${code} still uses English for: ${fallbacks.join(", ")}`,
      ).toEqual([]);
    },
  );
});
