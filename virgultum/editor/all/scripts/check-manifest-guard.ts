#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `check-manifest-guard.ts` — P-VIRG-ARCH-C-11 / C-FIND-07/08
 * runtime guard script.
 *
 * C-03 ships the `manifest-consistency-guard` as a
 * pure function inside the test surface
 * (`src/extensions/manifest-consistency-guard.ts`).
 * The unit test pins its contract.
 *
 * C-FIND-07 (P-VIRG-ARCH-C-11) makes the guard runnable
 * as a standalone CLI so CI / pre-commit can invoke
 * it without booting the Vitest harness. The CLI
 * reads each block package's `package.json` `exports`
 * map dynamically (C-FIND-08, P-VIRG-ARCH-C-12) so
 * the guard can never drift from the published
 * surface.
 *
 * **Why this script parses source instead of
 * importing the manifest modules.**
 *
 * The block manifest modules import the block's
 * store/view extension classes, which in turn pull
 * in `@virgultum/model` and `@virgultum/std`. Those
 * packages transitively reach the framework's
 * `dnd/` module, which uses JSX. A bare Node + tsx
 * setup cannot resolve JSX inside the framework
 * without additional configuration, and the goal of
 * this script is to be a **zero-build** CI hook
 * (no `tsc --build`, no `vite build`, just
 * `tsx scripts/check-manifest-guard.ts`).
 *
 * The C-03 guard only inspects three things on a
 * manifest: the `publicExports` array, whether
 * `store[0]` is a function, and whether `view[0]`
 * is a function. The first is a plain string
 * literal array; the latter two are class
 * references. Both are trivially extractable from
 * the source by a regex parser — no transpilation
 * needed.
 *
 * The class-reference presence is sufficient for
 * the `store-not-class` / `view-not-class` checks:
 * if the source mentions a class identifier in the
 * `store: [...]` slot, the slot is not null and not
 * a string. The real unit test (which actually
 * imports the classes) is the source of truth for
 * the *runtime* shape; this script's purpose is to
 * catch **drift between `package.json` `exports`
 * and `manifest.publicExports`** at CI time, which
 * is the C-FIND-08 concern.
 *
 * The script:
 *
 * 1. Resolves the repo root from `process.cwd()`.
 * 2. For each migrated block package:
 *    - Reads `<repo>/virgultum/editor/blocks/<id>/package.json`
 *      and extracts the `exports` map keys.
 *    - Reads `<repo>/virgultum/editor/blocks/<id>/src/manifest.ts`
 *      and extracts the `publicExports` array, the
 *      `store[0]` class identifier, and the
 *      `view[0]` class identifier.
 * 3. Calls the **real** `runConsistencyGuard`
 *    (imported from
 *    `@virgultum/editor/all/extensions/manifest-consistency-guard`)
 *    so there is exactly one source of truth for
 *    the shape rules. The unit test and the CLI
 *    consume the same function.
 * 4. Pretty-prints the issues. Exits with code 0
 *    on success, 1 on issues, 2 on setup error.
 *
 * Usage:
 *   yarn workspace @virgultum/editor/all guard:manifest
 *   bash build/scripts/test/guard-manifest.sh
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-11, C-FIND-07, C-FIND-08)
 * @see docs/dev/virgultum/todo/virgultum.md
 *      (LRN-20260610-VIRG-ARCH-C-FIND-07-GUARD-AS-TEST)
 *      (LRN-20260610-VIRG-ARCH-C-FIND-08-EXPECTED-EXPORTS-DRIFT)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type GuardEntry,
  type GuardIssue,
  runConsistencyGuard,
} from "../src/extensions/manifest-consistency-guard.js";

/**
 * The block packages that have a FeatureManifest
 * today (C-02 base four + P-VIRG-ARCH-I-02 Mermaid).
 * Add a new entry here when a new block lands a
 * manifest; the guard then checks it automatically.
 * The list is the bridge between "manifest exists"
 * and "guard runs against it".
 */
const MIGRATED_BLOCKS = ["divider", "event", "latex", "surface-ref", "mermaid"];

/**
 * A class placeholder returned by `extractManifest`.
 * The guard only needs `typeof === "function"` to
 * accept the slot; the placeholder is a no-op
 * arrow function.
 */
const CLASS_PLACEHOLDER: unknown = () => {
  // intentionally empty
};

/**
 * Resolve the repo root from the current working
 * directory. The script runs from the workspace
 * root (`yarn workspace ... guard:manifest`) and the
 * blocks live at `<root>/virgultum/editor/blocks/<id>`.
 */
function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(resolve(dir, "yarn.lock")) &&
      existsSync(resolve(dir, "package.json")) &&
      existsSync(resolve(dir, "virgultum/editor/blocks"))
    ) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new Error(
        "check-manifest-guard: could not find repo root from " +
          process.cwd() +
          " (no yarn.lock + virgultum/editor/blocks ancestor)",
      );
    }
    dir = parent;
  }
  throw new Error(
    "check-manifest-guard: repo root not found within 8 levels of " +
      process.cwd(),
  );
}

/**
 * Read the `exports` keys of a block package's
 * `package.json`. The guard compares them against
 * `manifest.publicExports`; a drift between the two
 * is a real bug.
 */
function readExpectedExports(
  repoRoot: string,
  blockId: string,
): ReadonlySet<string> {
  const pkgPath = resolve(
    repoRoot,
    "virgultum/editor/blocks",
    blockId,
    "package.json",
  );
  if (!existsSync(pkgPath)) {
    throw new Error(
      `check-manifest-guard: package.json not found at ${pkgPath}`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    exports?: unknown;
  };
  const exports = pkg.exports;
  if (!exports || typeof exports !== "object") {
    return new Set();
  }
  // `package.json` exports may be a string (shorthand)
  // or an object whose keys are the subpaths. We only
  // care about the keys.
  if (typeof exports === "string") {
    return new Set(["."]);
  }
  return new Set(Object.keys(exports as Record<string, unknown>));
}

/**
 * Extract the manifest object literal from a
 * `<block>/src/manifest.ts` source file using a
 * brace-balanced regex. We deliberately do not run
 * the module — see the file header for the
 * rationale.
 *
 * The extractor captures:
 *
 * - `publicExports`: an array of string literals
 *   (each quoted with `"` or `'` or backtick).
 * - `store`: an array whose first element is a class
 *   identifier. We capture the identifier name and
 *   replace it with a class placeholder.
 * - `view`: same as `store`.
 *
 * Limitations (intentional, documented):
 *
 * - The class identifier must appear as the first
 *   element of the `store` / `view` array. The
 *   four migrated blocks follow that convention
 *   (see `divider/src/manifest.ts`).
 * - The `publicExports` array must be a flat array
 *   of string literals. Template literals with
 *   interpolation are not supported (the migrated
 *   blocks do not use them).
 *
 * If the extractor fails, the script aborts with
 * a clear message naming the file.
 */
function extractManifest(
  repoRoot: string,
  blockId: string,
): {
  publicExports: string[];
  store: unknown[] | undefined;
  view: unknown[] | undefined;
} {
  const srcPath = resolve(
    repoRoot,
    "virgultum/editor/blocks",
    blockId,
    "src/manifest.ts",
  );
  if (!existsSync(srcPath)) {
    throw new Error(
      `check-manifest-guard: manifest source not found: ${srcPath}`,
    );
  }
  const source = readFileSync(srcPath, "utf8");

  // publicExports: \[[^\]]*\]
  const publicExports = extractStringArray(source, "publicExports");

  // store: [Ident]
  const store = extractFirstClassRef(source, "store");

  // view: [Ident]
  const view = extractFirstClassRef(source, "view");

  if (publicExports === null) {
    throw new Error(
      `check-manifest-guard: could not extract publicExports ` +
        `from ${srcPath}`,
    );
  }
  return { publicExports, store, view };
}

/**
 * Find a property of the form `<name>: [...]` and
 * return the array of string literals. Returns
 * `null` if the property is missing.
 */
function extractStringArray(source: string, name: string): string[] | null {
  // Match: <name>: [ ... ]  (non-greedy, no nested [])
  const re = new RegExp(`${name}\\s*:\\s*\\[([^\\]]*)\\]`, "m");
  const m = re.exec(source);
  if (!m) return null;
  const body = m[1] ?? "";
  // Each entry is a quoted string. Allow ", ', or `.
  const strRe = /["'`]([^"'`]+)["'`]/g;
  const out: string[] = [];
  for (;;) {
    const sm = strRe.exec(body);
    if (!sm) break;
    out.push(sm[1] ?? "");
  }
  return out;
}

/**
 * Find `<name>: [Ident, ...]` and return a one-element
 * array containing a class placeholder. Returns
 * `undefined` if the property is missing; returns
 * an empty array if the property is present but
 * empty.
 */
function extractFirstClassRef(
  source: string,
  name: string,
): unknown[] | undefined {
  // Match: <name>: [Ident, ...]
  const re = new RegExp(
    `${name}\\s*:\\s*\\[\\s*([A-Za-z_$][A-Za-z0-9_$]*)`,
    "m",
  );
  const m = re.exec(source);
  if (!m) {
    // Distinguish "missing" from "empty array" by
    // searching for the property at all.
    const exists = new RegExp(`${name}\\s*:\\s*\\[`, "m").test(source);
    if (exists) return [];
    return undefined;
  }
  return [CLASS_PLACEHOLDER];
}

function formatIssue(issue: GuardIssue): string {
  return `  [${issue.code}] ${issue.packageName}: ${issue.detail}`;
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const entries: GuardEntry[] = [];

  for (const blockId of MIGRATED_BLOCKS) {
    const packageName = `@virgultum/block-${blockId}`;
    const expectedExports = readExpectedExports(repoRoot, blockId);
    const { publicExports, store, view } = extractManifest(repoRoot, blockId);
    if (process.env["DEBUG_GUARD"] === "1") {
      console.error(
        `check-manifest-guard: ${packageName} ` +
          `(publicExports=${JSON.stringify(publicExports)}, ` +
          `expectedExports=${JSON.stringify([...expectedExports])}, ` +
          `store=${store === undefined ? "undefined" : store.length}, ` +
          `view=${view === undefined ? "undefined" : view.length})`,
      );
    }
    entries.push({
      packageName,
      manifest: {
        id: `synthetic-${blockId}` as GuardEntry["manifest"]["id"],
        publicExports,
        ...(store !== undefined ? { store } : {}),
        ...(view !== undefined ? { view } : {}),
      },
      expectedExports,
    });
  }

  const issues = runConsistencyGuard(entries);

  if (issues.length === 0) {
    console.log(`check-manifest-guard: ${entries.length} manifests, 0 issues.`);
    process.exit(0);
  }

  console.error(
    `check-manifest-guard: ${issues.length} issue(s) across ${entries.length} manifests:`,
  );
  for (const issue of issues) {
    console.error(formatIssue(issue));
  }
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`check-manifest-guard: setup error: ${message}`);
  process.exit(2);
});
