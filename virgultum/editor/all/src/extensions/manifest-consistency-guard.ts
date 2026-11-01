// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `manifest-consistency-guard.ts` - the
 * `P-VIRG-ARCH-C-03` manifest consistency guard.
 *
 * As of C-02, every block package exports a
 * `FeatureManifest` that lists the entry-points the
 * package surfaces. The guard verifies that:
 *
 * 1. The set of entry-points declared in
 *    `manifest.publicExports` matches the set declared
 *    in the package's `package.json` `exports` map.
 *    - A `publicExports` entry with no matching
 *      `exports` entry is an **extra-public-export**
 *      issue.
 *    - An `exports` entry that no manifest mentions is
 *      a **missing-public-export** issue.
 * 2. The `store` slot, when present, starts with a
 *    class (a `ExtensionProviderClass`).
 * 3. The `view` slot, when present, starts with a
 *    class.
 *
 * The guard is a **pure function**: it takes a list of
 * `{ packageName, manifest, expectedExports }` entries
 * and returns a list of `GuardIssue` objects. The
 * guard is intentionally side-effect-free so it is
 * safe to use in a unit test that exercises both the
 * happy path and a negative probe (a deliberately
 * broken manifest).
 *
 * The gate the build runs is the test in
 * `__tests__/manifest-consistency-guard.unit.spec.ts`;
 * that test pins the guard's contract by feeding it
 * the five migrated block manifests (divider, event,
 * latex, mermaid, surface-ref) plus a couple of
 * synthetic broken manifests and asserting the
 * expected issue codes.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-03)
 */

import type { FeatureManifest } from "@virgultum/ext-loader";

/**
 * Issue code returned by the guard. The string is the
 * stable identifier the build pipeline and debug
 * tooling match on; the `GuardIssue` object carries a
 * human-readable `detail` next to it.
 */
export type GuardIssueCode =
  | "extra-public-export"
  | "missing-public-export"
  | "store-not-class"
  | "view-not-class";

/**
 * A single issue surfaced by the guard. The guard
 * never throws; it accumulates issues and returns the
 * whole list so a CI gate can render them all at once.
 */
export interface GuardIssue {
  /** Stable identifier for the issue class. */
  readonly code: GuardIssueCode;
  /**
   * Name of the package the issue pertains to. Useful
   * when grouping issues in CI output.
   */
  readonly packageName: string;
  /** Human-readable description of the issue. */
  readonly detail: string;
}

/**
 * Input entry to the guard. The caller is expected to
 * pass the `expectedExports` set (typically derived
 * from the package's `package.json` `exports` map) so
 * the guard can compare it with `manifest.publicExports`.
 */
export interface GuardEntry {
  readonly packageName: string;
  readonly manifest: FeatureManifest;
  readonly expectedExports: ReadonlySet<string>;
}

/**
 * Run the guard over a list of entries. The returned
 * array is empty iff every entry passes.
 *
 * Validation rules (C-03):
 *
 * - `publicExports` ⊆ `expectedExports`. Every entry
 *   the manifest declares must exist in the package's
 *   `exports` map.
 * - `expectedExports` ⊆ `publicExports` (modulo
 *   `optional` semantics — see below). Every `exports`
 *   entry must be declared by the manifest. The
 *   exception is the `.` root entry: it is implied by
 *   any `publicExports` declaration that mentions
 *   `./manifest`/`./view`/`./store` etc., so the guard
 *   does **not** flag a missing `.` unless the manifest
 *   declares **no** `publicExports` at all.
 * - `store[0]` is a function (a class constructor).
 * - `view[0]` is a function (a class constructor).
 */
export function runConsistencyGuard(
  entries: ReadonlyArray<GuardEntry>,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  for (const entry of entries) {
    issues.push(...checkPublicExports(entry));
    issues.push(...checkSlotShape(entry));
  }
  return issues;
}

/**
 * Check `manifest.publicExports` against
 * `expectedExports`. The `.` root entry is treated as
 * optional: the manifest may declare a list of
 * subpath exports (e.g. `["./view", "./store",
 * "./manifest"]`) and the guard will only flag a
 * missing `.` if the manifest has **no** entry-point
 * declarations at all.
 */
export function checkPublicExports(entry: GuardEntry): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const declared = entry.manifest.publicExports ?? [];
  const declaredSet = new Set(declared);

  // Extra: manifest declares an entry that the package
  // does not export.
  for (const declared_ of declared) {
    if (!entry.expectedExports.has(declared_)) {
      issues.push({
        code: "extra-public-export",
        packageName: entry.packageName,
        detail:
          `manifest declares publicExports "${declared_}" ` +
          `but package.json exports map does not contain it`,
      });
    }
  }

  // Missing: package exports something the manifest
  // does not declare. The "." root is treated as
  // optional unless the manifest is empty.
  const nonRootExpected = [...entry.expectedExports].filter((e) => e !== ".");
  for (const expected of nonRootExpected) {
    if (!declaredSet.has(expected)) {
      issues.push({
        code: "missing-public-export",
        packageName: entry.packageName,
        detail:
          `package.json exports "${expected}" ` +
          `but manifest does not declare it in publicExports`,
      });
    }
  }

  // The "." root is mandatory when the manifest is
  // empty (no publicExports at all), but optional
  // otherwise. This is a softer rule; we do not
  // surface it as a hard issue.
  if (declared.length === 0 && entry.expectedExports.size > 0) {
    // No publicExports declarations: log as
    // missing-public-export so future feature
    // migrations get nudged toward declaring them.
    issues.push({
      code: "missing-public-export",
      packageName: entry.packageName,
      detail:
        `package.json exports ${entry.expectedExports.size} ` +
        `entry-points but manifest declares no publicExports`,
    });
  }

  return issues;
}

/**
 * Check that the `store` and `view` slots, when
 * present, start with a class constructor. A missing
 * `store` or `view` is fine (the manifest is allowed
 * to declare neither), but a present-but-empty array
 * or a present-but-non-class entry is an issue.
 */
export function checkSlotShape(entry: GuardEntry): GuardIssue[] {
  const issues: GuardIssue[] = [];
  if (entry.manifest.store !== undefined) {
    const first = entry.manifest.store[0];
    if (first === undefined) {
      issues.push({
        code: "store-not-class",
        packageName: entry.packageName,
        detail: `manifest declares an empty store array`,
      });
    } else if (typeof first !== "function") {
      issues.push({
        code: "store-not-class",
        packageName: entry.packageName,
        detail:
          `manifest.store[0] is ${typeof first}, ` +
          `expected a class constructor`,
      });
    }
  }
  if (entry.manifest.view !== undefined) {
    const first = entry.manifest.view[0];
    if (first === undefined) {
      issues.push({
        code: "view-not-class",
        packageName: entry.packageName,
        detail: `manifest declares an empty view array`,
      });
    } else if (typeof first !== "function") {
      issues.push({
        code: "view-not-class",
        packageName: entry.packageName,
        detail:
          `manifest.view[0] is ${typeof first}, ` +
          `expected a class constructor`,
      });
    }
  }
  return issues;
}
