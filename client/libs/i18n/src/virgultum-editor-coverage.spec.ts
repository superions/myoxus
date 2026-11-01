/**
 * @vitest-environment node
 */
/**
 * INV-VIRGULTUM-I18N-1: Active Virgultum/Core editor integration strings must
 *                        exist in the central client i18n resources.
 *
 * INV-VIRGULTUM-I18N-2: High-signal editor strings in the main localized
 *                        languages must be actual translations, not inherited
 *                        English fallback text.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import de from "./resources/de.json";
import en from "./resources/en.json";
import es from "./resources/es.json";
import fr from "./resources/fr.json";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const mainLocales = { de, es, fr } as const;
const allLocales = { de, en, es, fr } as const;
const scannedRoots = [
  "client/libs/core/src/editor",
  "client/libs/core/src/components/page-list/operation-menu-items/export.tsx",
  "client/libs/core/src/modules/share-menu/view/share-menu/share-menu.tsx",
  "client/libs/core/src/components/hooks/myoxus/use-register-virgultum-editor-commands.tsx",
] as const;
const editorMessageRoots = [
  "virgultum/editor",
  // Core also supplies descriptors from Database slash items and template
  // variable capabilities outside its editor directory.
  "client/libs/core/src",
] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

const staticKeyPatterns = [
  /(?:I18n|i18n|t)\.t\(\s*["']([^"']+)["']/g,
  /(?:I18n|t)\[\s*["']([^"']+)["']\s*\]/g,
  /\bi18nKey\s*=\s*["']([^"']+)["']/g,
  /\bi18nKey\s*:\s*["']([^"']+)["']/g,
  /\bi18nKey\s*=\s*\{\s*["']([^"']+)["']\s*\}/g,
] as const;
const editorMessagePattern = /\beditorMessage\(\s*["']([^"']+)["']/g;

const localizedQualityKeys = [
  "Export",
  "Export to Snapshot",
  "com.myoxus.db.file.upload-placeholder",
  "com.myoxus.db.member.already-exists",
  "com.myoxus.db.member.already-exists.message",
  "com.myoxus.db.member.loading",
  "com.myoxus.db.member.no-results",
  "com.myoxus.settings.editorSettings.edgeless.mind-map",
  "com.myoxus.sidebar.outline.settings",
  "com.myoxus.sidebar.outline.show-type-icon",
  "com.myoxus.editor.table.header-repeat-conflict",
] as const;

function walk(target: string): string[] {
  const fullTarget = join(repoRoot, target);
  const stat = statSync(fullTarget);
  if (stat.isFile()) {
    return sourceExtensions.has(extname(fullTarget)) ? [fullTarget] : [];
  }

  return readdirSync(fullTarget, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "coverage"
    ) {
      return [];
    }
    const full = join(fullTarget, entry.name);
    if (entry.isDirectory()) return walk(join(target, entry.name));
    return sourceExtensions.has(extname(full)) ? [full] : [];
  });
}

function isI18nKeyCandidate(value: string) {
  return (
    value.startsWith("com.myoxus.") ||
    value === "Export" ||
    value === "Export to Snapshot"
  );
}

function extractStaticKeys() {
  const keys = new Set<string>();

  for (const file of scannedRoots.flatMap((root) => walk(root))) {
    const source = readFileSync(file, "utf8");
    for (const pattern of staticKeyPatterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const key = match[1];
        if (isI18nKeyCandidate(key)) keys.add(key);
      }
    }
  }

  return [...keys].sort();
}

function extractEditorMessageKeys() {
  const keys = new Set<string>();

  for (const file of editorMessageRoots.flatMap((root) => walk(root))) {
    if (
      file.includes("/__tests__/") ||
      file.includes("/tests/") ||
      /\.(?:spec|test)\.[^.]+$/.test(file)
    )
      continue;
    const source = readFileSync(file, "utf8");
    editorMessagePattern.lastIndex = 0;
    for (const match of source.matchAll(editorMessagePattern)) {
      keys.add(match[1]);
    }
  }

  // The retained finite legacy bridge constructs descriptors from its map.
  // Its literal resources need the same coverage as direct editorMessage calls.
  const legacySource = readFileSync(
    join(
      repoRoot,
      "virgultum/editor/shared/src/services/legacy-editor-text.ts",
    ),
    "utf8",
  );
  for (const match of legacySource.matchAll(/"(com\.myoxus\.[^"]+|Delete)"/g)) {
    keys.add(match[1]);
  }

  // i18next resolves a counted base key through its plural variants.
  return [...keys]
    .flatMap((key) => {
      if (key in en) return [key];
      return Object.keys(en).filter(
        (resource) =>
          resource.startsWith(`${key}_`) &&
          /_(?:zero|one|two|few|many|other)$/.test(resource),
      );
    })
    .concat([...keys].filter((key) => !(key in en) && !(`${key}_other` in en)))
    .sort();
}

function placeholderTokens(value: string) {
  return Array.from(
    value.matchAll(/\{\{\s*(\w+)\s*\}\}/g),
    (match) => match[1],
  ).sort();
}

const editorMessageKeys = extractEditorMessageKeys();

describe("INV-VIRGULTUM-I18N-1: static editor i18n keys are centrally declared", () => {
  const staticKeys = extractStaticKeys();

  test.each(Object.entries(allLocales))(
    "%s contains every scanned editor key",
    (locale, dict) => {
      const missing = staticKeys.filter((key) => !(key in dict));
      expect(
        missing,
        `${locale} is missing Virgultum/Core editor i18n keys: ${missing.join(", ")}`,
      ).toEqual([]);
    },
  );
});

describe("INV-VIRGULTUM-I18N-1b: editor message descriptors cover main languages", () => {
  test.each(Object.entries(allLocales))(
    "%s contains every production EditorI18nMessage key",
    (locale, dict) => {
      const missing = editorMessageKeys.filter((key) => {
        const value = (dict as Record<string, string>)[key];
        return !value?.trim();
      });
      expect(
        missing,
        `${locale} is missing EditorI18nMessage keys: ${missing.join(", ")}`,
      ).toEqual([]);
    },
  );
});

describe("production editor descriptor interpolation", () => {
  test.each(Object.entries(mainLocales))(
    "%s preserves every descriptor placeholder",
    (_, dict) => {
      const mismatched = editorMessageKeys.filter(
        (key) =>
          placeholderTokens((dict as Record<string, string>)[key] ?? "").join(
            ",",
          ) !==
          placeholderTokens((en as Record<string, string>)[key] ?? "").join(
            ",",
          ),
      );
      expect(mismatched).toEqual([]);
    },
  );
});

describe("INV-VIRGULTUM-I18N-2: main locales do not inherit high-signal editor English", () => {
  test.each(Object.entries(mainLocales))(
    "%s owns the high-signal editor translations",
    (locale, dict) => {
      const inherited = localizedQualityKeys.filter(
        (key) => dict[key] === en[key],
      );
      expect(
        inherited,
        `${locale} still inherits editor English fallback strings: ${inherited.join(", ")}`,
      ).toEqual([]);
    },
  );
});
