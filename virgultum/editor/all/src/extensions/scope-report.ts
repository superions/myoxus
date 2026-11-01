// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `scope-report.ts` - the `P-VIRG-ARCH-C-04` scope report
 * for the editor aggregate's `FeatureManifestRegistry`.
 *
 * As of C-04, the `FeatureManifest.scopes` field (with
 * a default of `["page", "edgeless"]`) is the single
 * source of truth for which surfaces a feature is
 * mounted in. The scope report is the testable
 * artifact the build pipeline (and the Myoxus
 * `ViewManager` in `client/libs/core/src/editor/manager/view.ts`)
 * consumes to query which features are active for a
 * given surface.
 *
 * The report is a pure function over the
 * `FeatureManifestRegistry`:
 *
 * - `buildScopeReport(registry)` returns a frozen list
 *   of `ScopeReportEntry` objects, one per manifest
 *   in registration order.
 * - `featuresInScope(report, scope)` returns the
 *   subset of entries whose `effectiveScopes` includes
 *   the given `FeatureScope`.
 *
 * The Myoxus-side `Configure` chain in
 * `manager/view.ts` and the test suite both consume
 * the same report. A drift between the manifest
 * `scopes` and the runtime registration will be
 * caught by the `scope-report.unit.spec.ts` test
 * suite.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-04)
 */

import {
  effectiveScopes,
  type ExtensionProviderClass,
  type FeatureManifest,
  type FeatureManifestId,
  type FeatureManifestRegistry,
  type FeatureScope,
} from "@virgultum/ext-loader";

/**
 * One entry in the scope report. Carries the
 * effective scopes (after defaulting), the manifest
 * id, and a reference to the store/view extension
 * class (if any) for the manifest.
 */
export interface ScopeReportEntry {
  /** The manifest id. */
  readonly id: FeatureManifestId;
  /**
   * The scopes this feature is registered for, after
   * applying the default of `["page", "edgeless"]`
   * when the manifest omits the field.
   */
  readonly effectiveScopes: ReadonlyArray<FeatureScope>;
  /**
   * The first store-extension class the manifest
   * contributes, or `null` if the manifest has no
   * `store` slot. The registry only aggregates the
   * first entry today; C-XX passes may extend to
   * multi-extension manifests.
   */
  readonly storeExtensionClass: ExtensionProviderClass | null;
  /**
   * The first view-extension class the manifest
   * contributes, or `null` if the manifest has no
   * `view` slot.
   */
  readonly viewExtensionClass: ExtensionProviderClass | null;
}

/**
 * Build a frozen scope report from a registry. The
 * returned array is in registration order. Each
 * manifest contributes exactly one entry, even if
 * the manifest declares neither `store` nor `view`
 * (the entries still appear with `null`
 * extension classes, which is useful for verifying
 * that metadata-only features are still tracked).
 */
export function buildScopeReport(
  registry: FeatureManifestRegistry,
): ReadonlyArray<ScopeReportEntry> {
  return Object.freeze(
    registry.manifests.map((m: FeatureManifest) =>
      Object.freeze({
        id: m.id,
        effectiveScopes: Object.freeze(effectiveScopes(m).slice()),
        storeExtensionClass: (m.store && m.store[0]) || null,
        viewExtensionClass: (m.view && m.view[0]) || null,
      }),
    ),
  );
}

/**
 * Filter a scope report to the entries whose
 * `effectiveScopes` includes the given `scope`. The
 * result preserves the registration order of the
 * report.
 *
 * **Negative acceptance:** a manifest that declares
 * only `["page"]` does NOT appear in the result of
 * `featuresInScope(report, "edgeless")`. The test
 * suite exercises this property with a synthetic
 * scope-restricted manifest.
 */
export function featuresInScope(
  report: ReadonlyArray<ScopeReportEntry>,
  scope: FeatureScope,
): ReadonlyArray<ScopeReportEntry> {
  return report.filter((e) => e.effectiveScopes.includes(scope));
}

/**
 * Convenience: the union of `featuresInScope` for the
 * four scopes the C-04 acceptance criterion names
 * (`page`, `edgeless`, `mobile-page`,
 * `mobile-edgeless`). The returned arrays are
 * `Object.freeze`d so consumers can pass them around.
 */
export interface ScopeReportByScope {
  readonly page: ReadonlyArray<ScopeReportEntry>;
  readonly edgeless: ReadonlyArray<ScopeReportEntry>;
  readonly "mobile-page": ReadonlyArray<ScopeReportEntry>;
  readonly "mobile-edgeless": ReadonlyArray<ScopeReportEntry>;
}

export function buildScopeReportByScope(
  report: ReadonlyArray<ScopeReportEntry>,
): ScopeReportByScope {
  return Object.freeze({
    page: Object.freeze(featuresInScope(report, "page").slice()),
    edgeless: Object.freeze(featuresInScope(report, "edgeless").slice()),
    "mobile-page": Object.freeze(
      featuresInScope(report, "mobile-page").slice(),
    ),
    "mobile-edgeless": Object.freeze(
      featuresInScope(report, "mobile-edgeless").slice(),
    ),
  });
}
