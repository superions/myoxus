// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `import-boundary-guard.ts` — P-VIRG-ARCH-H-01
 * pure-function core of the import-boundary guard.
 *
 * This module is the **single source of truth** for the
 * Virgultum import-boundary rules. Both the standalone
 * CLI (`../scripts/check-import-boundaries.ts`) and the
 * unit test in this directory consume the exported
 * `runCheckOnSource` function. Adding or changing a rule
 * here is the only way to change the guard's behaviour
 * — the CLI is a thin wrapper, not a second
 * implementation.
 *
 * **Why pure functions and regex, not a TypeScript
 * AST.** A TS AST parser would require either
 * `ts.createSourceFile` (heavy startup, slow CI) or a
 * separate dependency on a real parser. The Virgultum
 * packages follow a strict `import { ... } from "..."`
 * shape, so a regex is sufficient to detect the four
 * forbidden patterns:
 *
 *   - `blocks`  → `@virgultum/editor/all`
 *   - `blocks`  → `@virgultum/editor/widgets/*`
 *   - `widgets` → `@virgultum/editor/all`
 *   - `widgets` → `@virgultum/editor/widgets/*`
 *
 * If the import shape ever becomes ambiguous (template
 * literals, dynamic imports), promote this to a real
 * AST parse — until then, the regex keeps the script
 * runnable in < 200 ms on the full `virgultum/` tree.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §H
 *      (P-VIRG-ARCH-H-01)
 */

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly importPath: string;
  readonly rule: string;
  readonly reason: string;
}

export interface ForbiddenImportPattern {
  readonly pattern: RegExp;
  readonly rule: string;
  readonly reason: string;
}

export interface PackageRule {
  readonly name: string;
  readonly pathPrefix: string; // e.g. "virgultum/editor/blocks"
  readonly forbiddenImportPatterns: ReadonlyArray<ForbiddenImportPattern>;
}

/**
 * Extract all `from "@virgultum/..."` import paths from a
 * single source file, with 1-based line numbers.
 *
 * The match targets both `from "<path>"` and `import "<path>"`
 * (static imports), and both single- and double-quoted strings.
 * Non-`@virgultum/` paths are filtered out at the yield site.
 */
export function* extractVirgultumImports(
  source: string,

  _file: string,
): Generator<{ line: number; importPath: string }> {
  const re = /(?:from|import)\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  let line = 1;
  let lastIndex = 0;
  while ((match = re.exec(source)) !== null) {
    // Count newlines from `lastIndex` to `match.index` to
    // determine the line of this match.
    const slice = source.slice(lastIndex, match.index);
    const newlines = (slice.match(/\n/g) ?? []).length;
    line += newlines;
    lastIndex = match.index + match[0].length;
    const importPath = match[1];
    if (importPath.startsWith("@virgultum/")) {
      yield { line, importPath };
    }
  }
}

/**
 * Run the rules over a single source string. Returns zero
 * or more violations, attributed to the file path that the
 * caller provides.
 *
 * `file` is used for `pathPrefix` matching (so the same
 * rules can be exercised from unit tests without writing
 * to disk).
 */
export function runCheckOnSource(
  source: string,
  file: string,
  rules: ReadonlyArray<PackageRule>,
): ReadonlyArray<Violation> {
  const applicable = rules.filter((r) => file.startsWith(r.pathPrefix + "/"));
  if (applicable.length === 0) return [];
  const violations: Violation[] = [];
  for (const { line, importPath } of extractVirgultumImports(source, file)) {
    for (const rule of applicable) {
      for (const forbidden of rule.forbiddenImportPatterns) {
        if (forbidden.pattern.test(importPath)) {
          violations.push({
            file,
            line,
            importPath,
            rule: forbidden.rule,
            reason: forbidden.reason,
          });
        }
      }
    }
  }
  return violations;
}
