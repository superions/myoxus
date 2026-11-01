// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `manifest.ts` - re-export of the `FeatureManifest`
 * types for `@virgultum/editor/all`.
 *
 * As of P-VIRG-ARCH-C-02, the canonical manifest types
 * live in `@virgultum/ext-loader` (a leaf package that
 * every block already depends on). This file
 * re-exports them so editor-aggregate consumers can
 * keep using `@virgultum/editor/all/manifest` as the
 * import path.
 *
 * The `hostServices` slot is intentionally typed as
 * `ReadonlyArray<string>` (the same loose type the
 * ext-loader core uses) so a manifest produced by a
 * block package (e.g. `block-divider/manifest`) is
 * structurally assignable to the editor-aggregate's
 * `FeatureManifest`. The editor/all-specific
 * `MyoxusHostCapability` enum is an editor-internal
 * contract used by Phase B-02's host service; it does
 * not need to be visible in the manifest type because
 * no block package declares `hostServices` (Mermaid
 * is locked out, and the migrated blocks don't bind
 * host capabilities).
 *
 * **Mermaid lock:** the `hostServices` slot will be
 * narrowed to `MyoxusHostCapability` in P-VIRG-ARCH-I
 * when the Mermaid family is opened for refactor.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-01, C-02)
 */

export {
  assertRegistryInvariants,
  checkRegistryInvariants,
  createFeatureManifestRegistry,
  effectiveScopes,
  type ExtensionProviderClass,
  type FeatureManifest,
  type FeatureManifestId,
  featureManifestId,
  type FeatureManifestRegistry,
  FeatureManifestRegistryError,
  type FeatureScope,
  isDocMode,
} from "@virgultum/ext-loader";
export {
  getModeSurfaceContractEntry,
  type MatrixRowId,
  MODE_SURFACE_CONTRACT,
  type ModeSurfaceContractEntry,
  validateManifestAgainstContract,
} from "@virgultum/ext-loader/mode-surface-contract";
