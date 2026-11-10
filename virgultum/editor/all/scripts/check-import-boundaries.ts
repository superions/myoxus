#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `check-import-boundaries.ts` — P-VIRG-ARCH-H-01 runtime guard.
 *
 * Virgultum-Packages haben eine gerichtete Abhaengigkeits-
 * Hierarchie:
 *
 *   framework  →  editor/{components, inlines, fragments, ...}
 *     ↑                ↓
 *   editor/{blocks, model, store, widgets, all}
 *     ↑                ↓
 *   tests/, client/libs/
 *
 * Konkret:
 *   1. **blocks** duerfen NUR von framework, model, store,
 *      components, inlines, fragments importieren.
 *      Sie duerfen NICHT von `@virgultum/editor/all` oder
 *      `@virgultum/editor/widgets/*` importieren (Blocks sind
 *      UI-Container, nicht UI-Widget-Inhaber).
 *   2. **widgets** duerfen NUR von framework, model, store,
 *      components, inlines, fragments importieren.
 *      Sie duerfen NICHT von `@virgultum/editor/all` oder
 *      anderen `@virgultum/editor/widgets/*` importieren
 *      (Widgets sind leaves, kein Widget-zu-Widget-Pfad).
 *
 * Diese Regeln werden ueber statische Source-Analyse
 * (Regex auf `from "@virgultum/..."`-Statements) gepflegt.
 * Kein Modul-Import, kein TS-Compiler — das Script ist
 * ein zero-build CI-Hook (siehe `check-manifest-guard.ts`
 * fuer die Begruendung).
 *
 * Die Pure-Logic (Regel-Anwendung + Regex-Extraktion) ist
 * in `../src/extensions/import-boundary-guard.ts` extrahiert,
 * damit sie ohne Subprocess-Start unit-getestet werden kann
 * (siehe `../src/extensions/__tests__/import-boundary-guard.unit.spec.ts`).
 *
 * **Ergebnis-Format:** exit 0 = clean, exit 1 = boundary
 * violation, exit 2 = setup error. Jede Violation wird mit
 * Datei:Zeile, Import-Pfad und Regel-ID ausgegeben, damit
 * der Fix-Pfad offensichtlich ist.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §H (P-VIRG-ARCH-H-01)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  type PackageRule,
  runCheckOnSource,
  type Violation,
} from "../src/extensions/import-boundary-guard.js";

const RULES: ReadonlyArray<PackageRule> = [
  {
    name: "blocks",
    pathPrefix: "virgultum/editor/blocks",
    forbiddenImportPatterns: [
      {
        pattern: /@virgultum\/editor\/all\b/,
        rule: "BLOCKS-CANNOT-IMPORT-ALL",
        reason:
          "blocks are leaves; they cannot import from the " +
          "@virgultum/editor/all aggregate (use the specific " +
          "feature-manifest path or @virgultum/editor/model)",
      },
      {
        pattern: /@virgultum\/editor\/widgets\//,
        rule: "BLOCKS-CANNOT-IMPORT-WIDGETS",
        reason:
          "blocks are UI containers, not widget holders; " +
          "use a feature manifest or @virgultum/editor/components instead",
      },
    ],
  },
  {
    name: "widgets",
    pathPrefix: "virgultum/editor/widgets",
    forbiddenImportPatterns: [
      {
        pattern: /@virgultum\/editor\/all\b/,
        rule: "WIDGETS-CANNOT-IMPORT-ALL",
        reason:
          "widgets are leaves; they cannot import from the " +
          "@virgultum/editor/all aggregate (use the specific " +
          "feature-manifest path or @virgultum/editor/model)",
      },
      {
        pattern: /@virgultum\/editor\/widgets\//,
        rule: "WIDGETS-CANNOT-IMPORT-WIDGETS",
        reason:
          "widgets are isolated; cross-widget imports are " +
          "forbidden (share via std or a common helper instead)",
      },
    ],
  },
];

/**
 * Walk the repo to find the root (yarn.lock + .git/ marker).
 */
function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock")) && existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new Error(
        "check-import-boundaries: could not find repo root from " +
          process.cwd(),
      );
    }
    dir = parent;
  }
  throw new Error(
    "check-import-boundaries: repo root not found within 8 levels of " +
      process.cwd(),
  );
}

/**
 * Recursively collect all .ts files under `root`, excluding
 * `dist/`, `node_modules/`, and `__tests__/fixtures/`.
 */
function* walkTsFiles(root: string): Generator<string> {
  const skipDirs = new Set([
    "dist",
    "node_modules",
    ".git",
    "coverage",
    "fixtures",
  ]);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (skipDirs.has(entry)) continue;
        stack.push(full);
      } else if (
        stat.isFile() &&
        entry.endsWith(".ts") &&
        !entry.endsWith(".d.ts")
      ) {
        yield full;
      }
    }
  }
}

/**
 * Read a file, run rules on it, and emit violations attributed
 * to the repo-relative path. Returns `null` if the file cannot
 * be read (which we silently skip — a missing file is the
 * walker's problem, not the rule's).
 */
function checkFile(
  file: string,
  repoRoot: string,
  rules: ReadonlyArray<PackageRule>,
): ReadonlyArray<Violation> {
  const rel = relative(repoRoot, file);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return runCheckOnSource(source, rel, rules);
}

/**
 * Walk all virgultum .ts files and report every boundary
 * violation.
 */
function runCheck(repoRoot: string): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  for (const tsFile of walkTsFiles(join(repoRoot, "virgultum"))) {
    violations.push(...checkFile(tsFile, repoRoot, RULES));
  }
  return violations;
}

function main(): void {
  const repoRoot = resolveRepoRoot();
  const violations = runCheck(repoRoot);
  if (violations.length === 0) {
    console.log(
      "Virgultum import-boundary check PASSED — " +
        "no forbidden cross-package imports",
    );
    process.exit(0);
  }
  console.error(
    `Virgultum import-boundary check FAILED — ${violations.length} violation(s):`,
  );
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  ${v.rule}\n` +
        `    import: ${v.importPath}\n` +
        `    reason: ${v.reason}`,
    );
  }
  process.exit(1);
}

main();
