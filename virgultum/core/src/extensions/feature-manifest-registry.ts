// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `feature-manifest-registry.ts` - runtime pieces for the
 * `FeatureManifestRegistry`. Lives in `ext-loader` so
 * individual block packages can use them when they
 * validate their own manifests. The editor aggregate
 * re-exports the same helpers and uses them for the
 * aggregate-wide registry.
 *
 * **No state outside the function arguments.** This file
 * is intentionally side-effect-free so it is safe to
 * import from any block package without surprising
 * initialization order effects.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-01, C-02)
 */

import type {
  ExtensionProviderClass,
  FeatureManifest,
  FeatureManifestId,
  FeatureManifestRegistry,
  FeatureScope,
} from "./feature-manifest";
import { FeatureManifestRegistryError } from "./feature-manifest";

const DEFAULT_SCOPES: ReadonlyArray<FeatureScope> = ["page", "edgeless"];

/**
 * Construct a registry from a list of manifests. The
 * returned object is frozen; consumers may freely pass
 * it around. Throws `FeatureManifestRegistryError` when
 * an invariant is violated.
 *
 * Validation rules:
 *
 * 1. Every manifest has a non-empty `id`.
 * 2. `id` is unique within the input list.
 * 3. The `effects` list is deduplicated while preserving
 *    first-seen order.
 * 4. The `store` and `view` extension lists are
 *    concatenated in input order. No dedup; the legacy
 *    arrays also do not dedup, and a regression here
 *    would change runtime registration.
 */
export function createFeatureManifestRegistry(
  manifests: ReadonlyArray<FeatureManifest>,
): FeatureManifestRegistry {
  const seenIds = new Set<FeatureManifestId>();
  const byId = new Map<FeatureManifestId, FeatureManifest>();
  const storeExtensions: ExtensionProviderClass[] = [];
  const viewExtensions: ExtensionProviderClass[] = [];
  const effectsSet = new Set<string>();
  const effectsOrdered: string[] = [];

  for (const manifest of manifests) {
    if (!manifest.id || (manifest.id as string).length === 0) {
      throw new FeatureManifestRegistryError(
        "manifest id must be a non-empty string",
        manifest.id,
      );
    }
    if (seenIds.has(manifest.id)) {
      throw new FeatureManifestRegistryError(
        `duplicate manifest id`,
        manifest.id,
      );
    }
    seenIds.add(manifest.id);
    byId.set(manifest.id, manifest);

    if (manifest.store) {
      for (const ext of manifest.store) {
        storeExtensions.push(ext);
      }
    }
    if (manifest.view) {
      for (const ext of manifest.view) {
        viewExtensions.push(ext);
      }
    }
    if (manifest.effects) {
      for (const effect of manifest.effects) {
        if (!effectsSet.has(effect)) {
          effectsSet.add(effect);
          effectsOrdered.push(effect);
        }
      }
    }
  }

  return Object.freeze({
    manifests: Object.freeze(manifests.slice()),
    storeExtensions: Object.freeze(storeExtensions),
    viewExtensions: Object.freeze(viewExtensions),
    effects: Object.freeze(effectsOrdered),
    byId: Object.freeze(new Map(byId)),
  });
}

/**
 * Resolve the effective scopes for a manifest. C-01
 * only consumes this for the scope report; the runtime
 * does not gate on it (D-01 makes it a hard contract).
 */
export function effectiveScopes(
  manifest: FeatureManifest,
): ReadonlyArray<FeatureScope> {
  return manifest.scopes ?? DEFAULT_SCOPES;
}

/**
 * Lightweight guard helper used by manifest-consistency
 * tests and Phase C-04. Asserts the registry invariants;
 * returns `null` on success or an error message on
 * failure. The throwing variant `assertRegistryInvariants`
 * is the preferred entry point for module-load-time
 * validation.
 */
export function checkRegistryInvariants(
  registry: FeatureManifestRegistry,
): string | null {
  if (registry.manifests.length !== registry.byId.size) {
    return `manifests (${registry.manifests.length}) and byId (${registry.byId.size}) disagree`;
  }
  for (const manifest of registry.manifests) {
    if (!registry.byId.has(manifest.id)) {
      return `manifest ${manifest.id} is missing from byId`;
    }
  }
  return null;
}

export function assertRegistryInvariants(
  registry: FeatureManifestRegistry,
): void {
  const error = checkRegistryInvariants(registry);
  if (error) {
    throw new FeatureManifestRegistryError(error);
  }
}
