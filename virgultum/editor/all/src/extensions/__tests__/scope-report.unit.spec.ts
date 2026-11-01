// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-C-04 scope-report tests.
 *
 * The scope report is the testable artifact the C-04
 * acceptance criterion names: a consumer can ask
 * "which extensions are active in scope X?" and the
 * answer comes from the `FeatureManifest.scopes` field
 * (with a default of `["page", "edgeless"]`).
 *
 * The test covers:
 *
 * 1. **Aggregate registry scope report.** The four
 *    scopes the spec names (`page`, `edgeless`,
 *    `mobile-page`, `mobile-edgeless`) are exercised
 *    against the live `internalManifestRegistry`. The
 *    default scope `["page", "edgeless"]` means every
 *    feature is in `page` and `edgeless`; the mobile
 *    scopes are empty until a feature declares them.
 * 2. **Custom scope reporting.** A synthetic
 *    `FeatureManifestRegistry` with a custom mix of
 *    scopes proves the filter logic.
 * 3. **Negative acceptance.** A feature that declares
 *    only `["page"]` is NOT in the `edgeless` report.
 *    A feature that declares only `["mobile-page"]`
 *    is NOT in the `page` or `edgeless` reports.
 * 4. **Report immutability.** The returned report and
 *    its per-scope slices are frozen, so consumers
 *    cannot mutate them.
 * 5. **`buildScopeReportByScope` returns the four
 *    required scopes** in a single object, with the
 *    correct ids.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-04)
 */

import {
  createFeatureManifestRegistry,
  type FeatureManifest,
  featureManifestId,
} from "@virgultum/ext-loader";
import { describe, expect, test } from "vitest";

import { internalManifestRegistry } from "../manifest-registry";
import {
  buildScopeReport,
  buildScopeReportByScope,
  featuresInScope,
} from "../scope-report";

describe("P-VIRG-ARCH-C-04 scope report", () => {
  describe("against the live internalManifestRegistry", () => {
    const report = buildScopeReport(internalManifestRegistry);

    test("report has one entry per manifest in registration order", () => {
      expect(report.length).toBe(internalManifestRegistry.manifests.length);
      for (let i = 0; i < report.length; i++) {
        expect(report[i].id).toBe(internalManifestRegistry.manifests[i].id);
      }
    });

    test("default scope is [page, edgeless] for manifests that omit scopes", () => {
      // Foundation is a manifest with no explicit
      // scopes. It should be active in both `page` and
      // `edgeless` (the default).
      const foundation = report.find(
        (e) => (e.id as unknown as string) === "foundation",
      );
      expect(foundation).toBeDefined();
      expect(foundation!.effectiveScopes).toContain("page");
      expect(foundation!.effectiveScopes).toContain("edgeless");
    });

    test("every feature is in the page scope (via default)", () => {
      const page = featuresInScope(report, "page");
      expect(page.length).toBe(report.length);
    });

    test("every feature is in the edgeless scope (via default)", () => {
      const edgeless = featuresInScope(report, "edgeless");
      expect(edgeless.length).toBe(report.length);
    });

    test("no feature declares mobile-page today", () => {
      const mobilePage = featuresInScope(report, "mobile-page");
      expect(mobilePage).toEqual([]);
    });

    test("no feature declares mobile-edgeless today", () => {
      const mobileEdgeless = featuresInScope(report, "mobile-edgeless");
      expect(mobileEdgeless).toEqual([]);
    });
  });

  describe("custom registry with mixed scopes", () => {
    const ONLY_PAGE: FeatureManifest = {
      id: featureManifestId("only-page"),
      store: undefined,
      view: undefined,
      scopes: ["page"],
    };
    const ONLY_EDGELESS: FeatureManifest = {
      id: featureManifestId("only-edgeless"),
      store: undefined,
      view: undefined,
      scopes: ["edgeless"],
    };
    const MOBILE_PAGE_ONLY: FeatureManifest = {
      id: featureManifestId("mobile-page-only"),
      store: undefined,
      view: undefined,
      scopes: ["mobile-page"],
    };
    const PREVIEW_BOTH: FeatureManifest = {
      id: featureManifestId("preview-both"),
      store: undefined,
      view: undefined,
      scopes: ["preview-page", "preview-edgeless"],
    };

    const registry = createFeatureManifestRegistry([
      ONLY_PAGE,
      ONLY_EDGELESS,
      MOBILE_PAGE_ONLY,
      PREVIEW_BOTH,
    ]);
    const report = buildScopeReport(registry);

    test("a page-only feature is in `page` but NOT in `edgeless`", () => {
      const page = featuresInScope(report, "page");
      const edgeless = featuresInScope(report, "edgeless");
      expect(page.map((e) => e.id as unknown as string)).toContain("only-page");
      expect(edgeless.map((e) => e.id as unknown as string)).not.toContain(
        "only-page",
      );
    });

    test("an edgeless-only feature is in `edgeless` but NOT in `page`", () => {
      const page = featuresInScope(report, "page");
      const edgeless = featuresInScope(report, "edgeless");
      expect(edgeless.map((e) => e.id as unknown as string)).toContain(
        "only-edgeless",
      );
      expect(page.map((e) => e.id as unknown as string)).not.toContain(
        "only-edgeless",
      );
    });

    test("a mobile-page feature is in `mobile-page` but NOT in `page` or `edgeless`", () => {
      const mobilePage = featuresInScope(report, "mobile-page");
      const page = featuresInScope(report, "page");
      const edgeless = featuresInScope(report, "edgeless");
      expect(mobilePage.map((e) => e.id as unknown as string)).toContain(
        "mobile-page-only",
      );
      expect(page.map((e) => e.id as unknown as string)).not.toContain(
        "mobile-page-only",
      );
      expect(edgeless.map((e) => e.id as unknown as string)).not.toContain(
        "mobile-page-only",
      );
    });

    test("a preview-both feature is in `preview-page` and `preview-edgeless` only", () => {
      const previewPage = featuresInScope(report, "preview-page");
      const previewEdgeless = featuresInScope(report, "preview-edgeless");
      const page = featuresInScope(report, "page");
      const edgeless = featuresInScope(report, "edgeless");
      expect(previewPage.map((e) => e.id as unknown as string)).toContain(
        "preview-both",
      );
      expect(previewEdgeless.map((e) => e.id as unknown as string)).toContain(
        "preview-both",
      );
      expect(page.map((e) => e.id as unknown as string)).not.toContain(
        "preview-both",
      );
      expect(edgeless.map((e) => e.id as unknown as string)).not.toContain(
        "preview-both",
      );
    });

    test("registration order is preserved within each scope", () => {
      const page = featuresInScope(report, "page");
      // page contains: only-page, mobile-page-only is NOT
      // in page, edgeless-only is NOT, preview-both is NOT.
      // So just `only-page` in the test registry.
      expect(page.length).toBe(1);
      expect(page[0].id as unknown as string).toBe("only-page");
    });
  });

  describe("report immutability", () => {
    const report = buildScopeReport(internalManifestRegistry);

    test("the report itself is frozen", () => {
      expect(Object.isFrozen(report)).toBe(true);
    });

    test("each entry's effectiveScopes is frozen", () => {
      for (const entry of report) {
        expect(Object.isFrozen(entry.effectiveScopes)).toBe(true);
      }
    });

    test("featuresInScope returns a fresh array (safe to mutate locally)", () => {
      const page = featuresInScope(report, "page");
      // Not frozen: a consumer can copy and reorder
      // without affecting the registry.
      expect(Object.isFrozen(page)).toBe(false);
    });
  });

  describe("buildScopeReportByScope", () => {
    const report = buildScopeReport(internalManifestRegistry);
    const byScope = buildScopeReportByScope(report);

    test("returns the four required scopes", () => {
      expect(byScope.page).toBeDefined();
      expect(byScope.edgeless).toBeDefined();
      expect(byScope["mobile-page"]).toBeDefined();
      expect(byScope["mobile-edgeless"]).toBeDefined();
    });

    test("each per-scope slice is frozen", () => {
      expect(Object.isFrozen(byScope.page)).toBe(true);
      expect(Object.isFrozen(byScope.edgeless)).toBe(true);
      expect(Object.isFrozen(byScope["mobile-page"])).toBe(true);
      expect(Object.isFrozen(byScope["mobile-edgeless"])).toBe(true);
    });

    test("page and edgeless slices match the live registry's manifest count", () => {
      // All features default to [page, edgeless], so
      // each slice has the full manifest count.
      expect(byScope.page.length).toBe(
        internalManifestRegistry.manifests.length,
      );
      expect(byScope.edgeless.length).toBe(
        internalManifestRegistry.manifests.length,
      );
    });

    test("mobile scopes are empty against the live registry", () => {
      expect(byScope["mobile-page"]).toEqual([]);
      expect(byScope["mobile-edgeless"]).toEqual([]);
    });
  });
});
