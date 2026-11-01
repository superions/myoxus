// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-C-03 manifest-consistency-guard tests.
 *
 * The guard is a pure function that takes a list of
 * `{ packageName, manifest, expectedExports }`
 * entries and returns a list of `GuardIssue` objects.
 * The test pins the guard's contract with two kinds
 * of cases:
 *
 * 1. **Happy path.** The five migrated block
 *    manifests (divider, event, latex, mermaid,
 *    surface-ref) pass the guard with zero issues.
 *    The `expectedExports` set is the truth the test
 *    asserts against; if a `package.json` `exports`
 *    map drifts from the test's expectation, this
 *    test goes red.
 * 2. **Negative probe.** Synthetic broken manifests
 *    feed the guard and assert the expected
 *    `GuardIssueCode` is raised. The negative probes
 *    cover all four guard codes:
 *    - `extra-public-export`: manifest declares
 *      `./nope` but the package does not export it.
 *    - `missing-public-export`: package exports
 *      `./store` but the manifest omits it.
 *    - `store-not-class`: `store[0]` is a string,
 *      not a class.
 *    - `view-not-class`: `view[0]` is missing
 *      (empty array).
 *
 * The negative probes use **synthetic manifests** in
 * memory, not the real product files. The test never
 * temporarily breaks a real package to exercise the
 * guard.
 *
 * C-FIND-07 / C-FIND-08 (P-VIRG-ARCH-C-11 / C-12):
 * the final describe block pins the **CI surface**
 * of the guard (the standalone CLI script, the
 * bash wrapper, the yarn `guard:manifest` script)
 * so a future refactor cannot accidentally remove
 * the hook without breaking the build.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-03, P-VIRG-ARCH-C-11, C-FIND-07,
 *       C-FIND-08)
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { dividerManifest } from "@virgultum/block-divider/manifest";
import { eventManifest } from "@virgultum/block-event/manifest";
import { latexManifest } from "@virgultum/block-latex/manifest";
import { mermaidManifest } from "@virgultum/block-mermaid/manifest";
import { surfaceRefManifest } from "@virgultum/block-surface-ref/manifest";
import { type FeatureManifest, featureManifestId } from "@virgultum/ext-loader";
import { describe, expect, test } from "vitest";

import {
  checkPublicExports,
  checkSlotShape,
  type GuardEntry,
  type GuardIssue,
  runConsistencyGuard,
} from "../manifest-consistency-guard";

/**
 * The expected `exports` map keys for each migrated
 * block. Mirrors the `package.json` `exports` field.
 * If a block adds a new subpath export, this test
 * must be updated to match.
 */
const MIGRATED = [
  {
    packageName: "@virgultum/block-divider",
    manifest: dividerManifest,
    expectedExports: new Set([".", "./view", "./store", "./manifest"]),
  },
  {
    packageName: "@virgultum/block-event",
    manifest: eventManifest,
    expectedExports: new Set([".", "./view", "./store", "./manifest"]),
  },
  {
    packageName: "@virgultum/block-latex",
    manifest: latexManifest,
    expectedExports: new Set([".", "./view", "./store", "./manifest"]),
  },
  {
    packageName: "@virgultum/block-mermaid",
    manifest: mermaidManifest,
    expectedExports: new Set([".", "./view", "./store", "./manifest"]),
  },
  {
    packageName: "@virgultum/block-surface-ref",
    manifest: surfaceRefManifest,
    expectedExports: new Set([".", "./view", "./store", "./manifest"]),
  },
] as const satisfies ReadonlyArray<GuardEntry>;

describe("P-VIRG-ARCH-C-03 manifest-consistency-guard", () => {
  describe("happy path: migrated block manifests", () => {
    test("all five migrated manifests pass with zero issues", () => {
      const issues = runConsistencyGuard(MIGRATED);
      expect(issues).toEqual([]);
    });

    test("checkPublicExports alone passes for every migrated block", () => {
      for (const entry of MIGRATED) {
        const issues = checkPublicExports(entry);
        expect(
          issues,
          `unexpected issues for ${entry.packageName}: ${JSON.stringify(issues)}`,
        ).toEqual([]);
      }
    });

    test("checkSlotShape alone passes for every migrated block", () => {
      for (const entry of MIGRATED) {
        const issues = checkSlotShape(entry);
        expect(
          issues,
          `unexpected issues for ${entry.packageName}: ${JSON.stringify(issues)}`,
        ).toEqual([]);
      }
    });
  });

  describe("negative probe: extra-public-export", () => {
    test("manifest declares an entry the package does not export", () => {
      // Real DividerStoreExtension is a class, so we
      // reuse it as the store slot to keep the
      // slot-shape check happy.
      const broken: FeatureManifest = {
        id: featureManifestId("broken-extra-export"),
        store: [dividerManifest.store![0]],
        view: [dividerManifest.view![0]],
        // "./nope" is not in expectedExports.
        publicExports: [".", "./view", "./store", "./nope"],
      };
      const entry: GuardEntry = {
        packageName: "@virgultum/test-extra-export",
        manifest: broken,
        expectedExports: new Set([".", "./view", "./store"]),
      };
      const issues = runConsistencyGuard([entry]);
      const codes = issues.map((i) => i.code);
      expect(codes).toContain("extra-public-export");
      const issue = issues.find((i) => i.code === "extra-public-export")!;
      expect(issue.packageName).toBe("@virgultum/test-extra-export");
      expect(issue.detail).toContain("./nope");
    });
  });

  describe("negative probe: missing-public-export", () => {
    test("package exports ./store but the manifest omits it", () => {
      const broken: FeatureManifest = {
        id: featureManifestId("broken-missing-export"),
        store: [dividerManifest.store![0]],
        view: [dividerManifest.view![0]],
        // Note: "./store" is missing.
        publicExports: [".", "./view", "./manifest"],
      };
      const entry: GuardEntry = {
        packageName: "@virgultum/test-missing-export",
        manifest: broken,
        expectedExports: new Set([".", "./view", "./store", "./manifest"]),
      };
      const issues = runConsistencyGuard([entry]);
      const codes = issues.map((i) => i.code);
      expect(codes).toContain("missing-public-export");
      const issue = issues.find((i) => i.code === "missing-public-export")!;
      expect(issue.detail).toContain("./store");
    });

    test("manifest with no publicExports at all raises missing-public-export", () => {
      const broken: FeatureManifest = {
        id: featureManifestId("broken-no-public-exports"),
        store: [dividerManifest.store![0]],
        view: [dividerManifest.view![0]],
        // No publicExports.
      };
      const entry: GuardEntry = {
        packageName: "@virgultum/test-no-public-exports",
        manifest: broken,
        expectedExports: new Set([".", "./view", "./store", "./manifest"]),
      };
      const issues = runConsistencyGuard([entry]);
      const codes = issues.map((i) => i.code);
      expect(codes).toContain("missing-public-export");
    });
  });

  describe("negative probe: store-not-class", () => {
    test("store[0] is a string, not a class constructor", () => {
      const broken: FeatureManifest = {
        id: featureManifestId("broken-store-shape"),
        // @ts-expect-error -- intentional negative probe
        store: ["not-a-class"],
        view: [dividerManifest.view![0]],
        publicExports: [".", "./view", "./store"],
      };
      const entry: GuardEntry = {
        packageName: "@virgultum/test-store-shape",
        manifest: broken,
        expectedExports: new Set([".", "./view", "./store"]),
      };
      const issues = runConsistencyGuard([entry]);
      const codes = issues.map((i) => i.code);
      expect(codes).toContain("store-not-class");
    });

    test("store array is empty raises store-not-class", () => {
      const broken: FeatureManifest = {
        id: featureManifestId("broken-empty-store"),
        store: [],
        view: [dividerManifest.view![0]],
        publicExports: [".", "./view", "./store"],
      };
      const entry: GuardEntry = {
        packageName: "@virgultum/test-empty-store",
        manifest: broken,
        expectedExports: new Set([".", "./view", "./store"]),
      };
      const issues = runConsistencyGuard([entry]);
      const codes = issues.map((i) => i.code);
      expect(codes).toContain("store-not-class");
    });
  });

  describe("negative probe: view-not-class", () => {
    test("view array is empty raises view-not-class", () => {
      const broken: FeatureManifest = {
        id: featureManifestId("broken-empty-view"),
        store: [dividerManifest.store![0]],
        view: [],
        publicExports: [".", "./view", "./store"],
      };
      const entry: GuardEntry = {
        packageName: "@virgultum/test-empty-view",
        manifest: broken,
        expectedExports: new Set([".", "./view", "./store"]),
      };
      const issues = runConsistencyGuard([entry]);
      const codes = issues.map((i) => i.code);
      expect(codes).toContain("view-not-class");
    });
  });

  describe("issue shape", () => {
    test("every issue carries code, packageName, and detail", () => {
      // Compose several issues by running two broken
      // entries through the guard.
      const broken1: FeatureManifest = {
        id: featureManifestId("broken-shape-1"),
        store: [dividerManifest.store![0]],
        // @ts-expect-error -- intentional negative probe
        view: [42],
        publicExports: [".", "./view", "./store", "./nope"],
      };
      const entry1: GuardEntry = {
        packageName: "@virgultum/test-shape-1",
        manifest: broken1,
        expectedExports: new Set([".", "./view", "./store"]),
      };
      const issues: GuardIssue[] = runConsistencyGuard([entry1]);
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.code).toBeTruthy();
        expect(issue.packageName).toBe("@virgultum/test-shape-1");
        expect(issue.detail).toBeTruthy();
        expect(typeof issue.detail).toBe("string");
      }
    });
  });

  describe("C-FIND-07/08: CI surface for the guard", () => {
    /**
     * The repo root is the parent of the
     * `virgultum/` directory. The Vitest cwd can be
     * the repo root (root-level `yarn vitest run`) or
     * the package root (`yarn vitest run` from
     * inside `@virgultum/editor/all`); the resolver
     * walks up until it finds a directory whose
     * child is `virgultum/editor/blocks`.
     */
    function resolveRepoRoot(startDir: string): string {
      let dir = startDir;
      for (let i = 0; i < 8; i++) {
        if (
          statSync(join(dir, "virgultum/editor/blocks"), {
            throwIfNoEntry: false,
          }) !== undefined
        ) {
          return dir;
        }
        const parent = join(dir, "..");
        if (parent === dir) {
          throw new Error(
            "manifest-consistency-guard spec: could not resolve " +
              "repo root from " +
              startDir,
          );
        }
        dir = parent;
      }
      throw new Error(
        "manifest-consistency-guard spec: repo root not found " +
          "within 8 levels of " +
          startDir,
      );
    }

    /**
     * C-FIND-07 (P-VIRG-ARCH-C-11) made the guard
     * runnable outside the Vitest harness via a
     * `yarn workspace @virgultum/editor/all
     * guard:manifest` script and a bash wrapper at
     * `build/scripts/test/guard-manifest.sh`.
     *
     * C-FIND-08 (P-VIRG-ARCH-C-12) made the guard
     * read each block's `package.json` `exports` map
     * dynamically. The test below verifies that
     * the runtime `expectedExports` set derived
     * from `package.json` matches the test's
     * hard-coded `expectedExports` set; if the
     * block ever adds a new subpath export, the
     * test forces the maintainer to update the
     * `MIGRATED` table to keep the guard aligned
     * with the published surface.
     */
    test("runtime expectedExports (from package.json) match the test table", () => {
      const repoRoot = resolveRepoRoot(process.cwd());
      for (const entry of MIGRATED) {
        const blockId = entry.packageName.replace("@virgultum/block-", "");
        const pkgPath = join(
          repoRoot,
          "virgultum/editor/blocks",
          blockId,
          "package.json",
        );
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          exports?: Record<string, unknown>;
        };
        const runtimeExports = new Set(Object.keys(pkg.exports ?? {}));
        // The runtime set must equal the test
        // table's set. This is the C-FIND-08
        // drift guard: if a block adds a new
        // subpath export, this assertion fires
        // and the maintainer must update the
        // test table (so the in-test guard and
        // the runtime guard stay aligned).
        expect(
          [...runtimeExports].sort(),
          `runtime expectedExports drift for ${entry.packageName}; ` +
            `add the new subpath to the MIGRATED table`,
        ).toEqual([...entry.expectedExports].sort());
      }
    });

    test("CI surface files exist and are wired up", () => {
      const repoRoot = resolveRepoRoot(process.cwd());
      const scriptPath = join(
        repoRoot,
        "virgultum/editor/all/scripts/check-manifest-guard.ts",
      );
      const wrapperPath = join(
        repoRoot,
        "build/scripts/test/guard-manifest.sh",
      );
      const pkgPath = join(repoRoot, "virgultum/editor/all/package.json");

      // The TypeScript CLI source.
      expect(() => statSync(scriptPath)).not.toThrow();
      // The bash wrapper.
      const wrapperStat = statSync(wrapperPath);
      expect(wrapperStat.isFile()).toBe(true);
      // The bash wrapper must be executable (0o111
      // bit set). A future chmod regression would
      // silently break the CI hook.
      expect(
        (wrapperStat.mode & 0o111) !== 0,
        "guard-manifest.sh is not executable",
      ).toBe(true);

      // The yarn script must be registered.
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const guardScript = pkg.scripts?.["guard:manifest"];
      expect(guardScript, "guard:manifest yarn script is missing").toBe(
        "npx --no-install tsx scripts/check-manifest-guard.ts",
      );
    });
  });
});
