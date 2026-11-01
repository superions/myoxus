/**
 * INV-MERMAID-I18N-1: Mermaid editor chrome is sourced from the central
 *                      client i18n resources, not from ad-hoc UI literals.
 */
import { readFileSync } from "node:fs";

import {
  MERMAID_I18N_KEYS,
  MERMAID_SHARED_I18N_KEYS,
} from "@virgultum/block-mermaid";
import { describe, expect, test } from "vitest";

import de from "./resources/de.json";
import en from "./resources/en.json";

const PREFIX = "com.myoxus.editor.mermaid.";
const enDict = en as Record<string, string>;
const deDict = de as Record<string, string>;
const mermaidKeys = Object.keys(enDict).filter((key) => key.startsWith(PREFIX));
const mermaidBlockKeys = Object.values(MERMAID_I18N_KEYS).map(
  (key) => `${PREFIX}${key}`,
);
const mainLocalizedLocaleCodes = ["de", "fr", "es"] as const;
const intentionalIdenticalTranslations: Record<string, Set<string>> = {
  fr: new Set([
    "com.myoxus.editor.mermaid.mode-source",
    "com.myoxus.editor.mermaid.shape-rect",
  ]),
};

function loadLocale(code: string): Record<string, string> {
  const file = new URL(`./resources/${code}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}

function placeholderTokens(value: string) {
  return Array.from(
    value.matchAll(/\{\{(\w+)\}\}/g),
    (match) => match[1],
  ).sort();
}

describe("INV-MERMAID-I18N-1: central Mermaid editor i18n coverage", () => {
  test("en.json declares the full Mermaid block key registry", () => {
    expect(new Set(mermaidKeys)).toEqual(new Set(mermaidBlockKeys));
    expect(mermaidKeys).toContain(
      "com.myoxus.editor.mermaid.selected-journey-actors",
    );
    expect(mermaidKeys).toContain(
      "com.myoxus.editor.mermaid.selected-task-duration",
    );
    expect(mermaidKeys).toContain(
      "com.myoxus.editor.mermaid.selected-planning-lane-title",
    );
    expect(mermaidKeys).toContain(
      "com.myoxus.editor.mermaid.visual-add-planning-item",
    );
  });

  test.each(["en", ...mainLocalizedLocaleCodes])(
    "%s includes every Mermaid editor key",
    (code) => {
      const dict = loadLocale(code);
      const missing = [
        ...mermaidKeys,
        ...Object.values(MERMAID_SHARED_I18N_KEYS),
      ].filter((key) => !(key in dict));

      expect(
        missing,
        `${code} is missing Mermaid editor keys: ${missing.join(", ")}`,
      ).toEqual([]);
    },
  );

  test.each(mainLocalizedLocaleCodes)(
    "%s localizes Mermaid editor strings instead of inheriting English fallbacks",
    (code) => {
      const dict = code === "de" ? deDict : loadLocale(code);
      const intentionallyIdentical =
        intentionalIdenticalTranslations[code] ?? new Set<string>();
      const inherited = mermaidKeys.filter(
        (key) => dict[key] === enDict[key] && !intentionallyIdentical.has(key),
      );

      expect(
        inherited,
        `${code} still inherits English Mermaid editor strings: ${inherited.join(", ")}`,
      ).toEqual([]);
    },
  );

  test.each(mainLocalizedLocaleCodes)(
    "%s preserves Mermaid interpolation placeholders",
    (code) => {
      const dict = code === "de" ? deDict : loadLocale(code);
      const mismatched = mermaidKeys.filter((key) => {
        return (
          placeholderTokens(dict[key]).join(",") !==
          placeholderTokens(enDict[key]).join(",")
        );
      });

      expect(
        mismatched,
        `${code} has Mermaid placeholder drift: ${mismatched.join(", ")}`,
      ).toEqual([]);
    },
  );
});
