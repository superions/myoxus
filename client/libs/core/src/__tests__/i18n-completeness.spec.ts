/**
 * @vitest-environment node
 */
/**
 * EN is the base inventory; DE/FR/ES must contain every Web and Admin key.
 * Other locales are optional under the 2026-09-06 language policy. Their
 * existing translations remain covered by the applicable quality guards.
 */
import { describe, expect, test } from "vitest";

const BASE = "../../../i18n/src/resources";

async function loadLocale(lang: string): Promise<Record<string, string>> {
  const m = await import(`${BASE}/${lang}.json`);
  return (m.default ?? m) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Main languages — all keys (web + admin.*)
// ---------------------------------------------------------------------------
describe("i18n completeness — main languages: all keys", () => {
  const langs = ["de", "fr", "es"] as const;

  for (const lang of langs) {
    test(`inv_i18n_completeness_tier1_${lang.replace(/-/g, "_")}`, async () => {
      const en = await loadLocale("en");
      const loc = await loadLocale(lang);
      const missing = Object.keys(en).filter((k) => !(k in loc));
      expect(
        missing,
        `${lang}.json missing ${missing.length} keys: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`,
      ).toEqual([]);
    });
  }
});
