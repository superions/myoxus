// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-C-02 manifest-import tests.
 *
 * As of C-02, the four low-risk blocks
 * (`divider`, `event`, `latex`, `surface-ref`) export
 * their own `FeatureManifest` from the `./manifest`
 * subpath, and the editor aggregate imports those
 * manifests instead of declaring them inline. This
 * test verifies:
 *
 * 1. Each of the four packages exposes a `./manifest`
 *    subpath that resolves to a `FeatureManifest` with
 *    a non-empty `id`.
 * 2. Each manifest contributes exactly one store
 *    extension and one view extension.
 * 3. The `publicExports` slot lists `./manifest`
 *    alongside the package's other entry-points
 *    (`./`, `./view`, `./store`).
 * 4. The `id` of the imported manifest matches the id
 *    the editor-aggregate registry knows under (so
 *    `INTERNAL_STORE_ORDER` / `INTERNAL_VIEW_ORDER`
 *    lookups hit the right entry).
 *
 * The aggregate-wide "byte-for-byte equal to legacy"
 * test (the C-01 invariant) lives in
 * `manifest-consistency.unit.spec.ts` and is **not**
 * duplicated here.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-02)
 */

import { dividerManifest } from "@virgultum/block-divider/manifest";
import { eventManifest } from "@virgultum/block-event/manifest";
import { latexManifest } from "@virgultum/block-latex/manifest";
import { surfaceRefManifest } from "@virgultum/block-surface-ref/manifest";
import { describe, expect, test } from "vitest";

import { internalManifestRegistry } from "../manifest-registry";

const MIGRATED = [
  { name: "divider", manifest: dividerManifest, id: "divider" },
  { name: "event", manifest: eventManifest, id: "event" },
  { name: "latex", manifest: latexManifest, id: "latex" },
  { name: "surface-ref", manifest: surfaceRefManifest, id: "surface-ref" },
] as const;

describe("P-VIRG-ARCH-C-02 migrated block manifests", () => {
  test("the aggregate registry has a manifest for every migrated block", () => {
    for (const { id, name } of MIGRATED) {
      const inRegistry = internalManifestRegistry.manifests.some(
        (m) => (m.id as unknown as string) === id,
      );
      expect(
        inRegistry,
        `registry must contain a manifest for migrated block "${name}" (id "${id}")`,
      ).toBe(true);
    }
  });

  test("each migrated block's manifest is the same object the registry uses", () => {
    for (const { id, manifest, name } of MIGRATED) {
      const inRegistry = internalManifestRegistry.byId.get(
        // brand-equal comparison
        manifest.id,
      );
      expect(
        inRegistry,
        `registry lookup by manifest.id must succeed for "${name}"`,
      ).toBeDefined();
      // The registry entry should reference the same
      // manifest object the block package exports, so
      // the manifest lives in one place.
      expect(inRegistry).toBe(manifest);
      // The id matches what the aggregate's INTERNAL_*
      // _ORDER arrays use.
      expect(inRegistry!.id as unknown as string).toBe(id);
    }
  });

  describe("per-package shape", () => {
    for (const { name, manifest } of MIGRATED) {
      test(`${name}: id is a non-empty string`, () => {
        expect(manifest.id).toBeTruthy();
        expect((manifest.id as unknown as string).length).toBeGreaterThan(0);
      });

      test(`${name}: contributes exactly one store extension`, () => {
        expect(manifest.store).toBeDefined();
        expect(manifest.store).toHaveLength(1);
      });

      test(`${name}: contributes exactly one view extension`, () => {
        expect(manifest.view).toBeDefined();
        expect(manifest.view).toHaveLength(1);
      });

      test(`${name}: publicExports lists the manifest entry-point`, () => {
        expect(manifest.publicExports).toBeDefined();
        expect(manifest.publicExports).toContain("./manifest");
        expect(manifest.publicExports).toContain("./view");
        expect(manifest.publicExports).toContain("./store");
        expect(manifest.publicExports).toContain(".");
      });
    }
  });
});
