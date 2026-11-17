// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Feature contribution contracts shared by Core's extension loaders and
 * concrete block owners. The Editor assembly re-exports the same contracts;
 * registry construction lives in `feature-manifest-registry.ts`.
 */

import type { DocMode } from "../models/index";

/**
 * Stable identifier for a feature manifest. The id is the
 * surface that tests, debug tooling, and `track.*` use to
 * attribute behaviour; it MUST be unique within a registry.
 *
 * Recommended naming: `kebab-case-feature-name`, e.g.
 * `"event-block"`, `"bpmn-block"`, `"kanban-preset"`.
 */
export type FeatureManifestId = string & {
  readonly __brand: "FeatureManifestId";
};

/** Helper to brand a string as a `FeatureManifestId`. */
export const featureManifestId = (raw: string): FeatureManifestId =>
  raw as FeatureManifestId;

/**
 * Surface scope a feature is registered for. Mirrors the
 * `refactor-roadmap.md` §11 (M01..M15) matrix rows.
 *
 * The default `["page", "edgeless"]` covers the common
 * case where a feature is mounted in both Page and
 * Edgeless modes. Preview scopes (`"preview-page"`,
 * `"preview-edgeless"`) are opt-in and are typically
 * narrower (read-only). Mobile scopes are
 * `mobile-page` / `mobile-edgeless`.
 */
export type FeatureScope =
  | "page"
  | "edgeless"
  | "preview-page"
  | "preview-edgeless"
  | "mobile-page"
  | "mobile-edgeless";

/**
 * Loose class type for an extension provider. The legacy
 * store/view extension arrays are arrays of
 * `typeof BaseExtensionProvider<Scope>` subclasses; the
 * registry does not instantiate them, it only stores
 * them and passes them through to the existing
 * `ExtensionManager`. A `new (...args: any[]) => any` is
 * sufficient for the manifest's purposes; the manager-
 * side type check stays in `view-manager.ts` /
 * `store-manager.ts`.
 */
export type ExtensionProviderClass = new (...args: any[]) => any;

/**
 * A single feature manifest declaration. Every field is
 * optional except `id`; an empty manifest (no `store`,
 * no `view`, no `effects`) is valid and is used by
 * feature packages that contribute only metadata.
 *
 * The `hostServices` slot is typed loosely as
 * `ReadonlyArray<string>` here so this file does not
 * pull in `MyoxusHostCapability` (an editor/all-level
 * enum). The editor/all re-export of this type narrows
 * the slot to `MyoxusHostCapability` for editor-internal
 * use. Block packages (which use this loose version)
 * never set `hostServices`.
 */
export interface FeatureManifest {
  /** Stable, unique id. Required. */
  readonly id: FeatureManifestId;
  /**
   * Store extensions contributed by this feature. The
   * order of `store` is the registration order in the
   * store-extension array.
   */
  readonly store?: ReadonlyArray<ExtensionProviderClass>;
  /**
   * View extensions contributed by this feature. The
   * order of `view` is the registration order in the
   * view-extension array.
   */
  readonly view?: ReadonlyArray<ExtensionProviderClass>;
  /**
   * Effects the feature requires. Effects are not
   * aggregated by the registry in C-01/C-02; the manifest
   * only declares which effects a feature pulls in.
   */
  readonly effects?: ReadonlyArray<string>;
  /**
   * Modes / surfaces this feature is registered for. The
   * default `["page", "edgeless"]` is applied when the
   * field is omitted.
   */
  readonly scopes?: ReadonlyArray<FeatureScope>;
  /**
   * Feature flags the feature reads. Used by Phase C-04's
   * ViewManager to align manifest scope reports with
   * flag-gated behaviour.
   */
  readonly featureFlag?: ReadonlyArray<string>;
  /**
   * Host-service capabilities the feature requires.
   * Typed loosely as `ReadonlyArray<string>` so this
   * file does not depend on the editor/all-level
   * `MyoxusHostCapability` enum. The aggregate
   * re-exports a stricter version.
   */
  readonly hostServices?: ReadonlyArray<string>;
  /**
   * Public exports the feature adds to the package
   * surface. C-03's manifest-consistency-guard uses
   * this to detect "package exports a symbol but no
   * manifest entry exists" regressions.
   */
  readonly publicExports?: ReadonlyArray<string>;
  /**
   * Test tags the feature's specs add. Used by
   * `vitest --testTags=...` filters.
   */
  readonly testTags?: ReadonlyArray<string>;
}

/**
 * Aggregated, validated registry. Built via
 * `createFeatureManifestRegistry` from a frozen list of
 * manifests; the arrays on this object are the single
 * source of truth for the editor's extension ordering.
 */
export interface FeatureManifestRegistry {
  /** All manifests in registration order. */
  readonly manifests: ReadonlyArray<FeatureManifest>;
  /**
   * The store extensions in registration order.
   */
  readonly storeExtensions: ReadonlyArray<ExtensionProviderClass>;
  /**
   * The view extensions in registration order.
   */
  readonly viewExtensions: ReadonlyArray<ExtensionProviderClass>;
  /**
   * The set of distinct effect identifiers declared
   * across all manifests. Used to detect duplicate or
   * missing effect declarations.
   */
  readonly effects: ReadonlyArray<string>;
  /**
   * Map of `FeatureManifestId` to the manifest. Used by
   * tests and by Phase C-04's scope report.
   */
  readonly byId: ReadonlyMap<FeatureManifestId, FeatureManifest>;
}

/**
 * Error raised by `createFeatureManifestRegistry` when
 * the manifest list violates an invariant (duplicate id,
 * empty id, mismatched scope, ...). The error is
 * intended to be thrown at module-load time so a
 * regression turns the build red instead of silently
 * producing a broken registry.
 */
export class FeatureManifestRegistryError extends Error {
  constructor(
    message: string,
    readonly manifestId?: FeatureManifestId,
  ) {
    super(
      manifestId
        ? `[FeatureManifestRegistry] ${message} (manifest id: ${manifestId})`
        : `[FeatureManifestRegistry] ${message}`,
    );
    this.name = "FeatureManifestRegistryError";
  }
}

/**
 * Type guard for `DocMode` values. Used by tests that
 * need to assert the registry's `scopes` field contains
 * only valid `DocMode` entries.
 */
export function isDocMode(value: string): value is DocMode {
  return value === "page" || value === "edgeless";
}
