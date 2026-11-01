// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-I-02 mermaid manifest-import tests.
 *
 * As of I-02, the `mermaid` block exports its own
 * `FeatureManifest` from the `./manifest` subpath, and
 * the editor aggregate imports that manifest instead of
 * declaring it inline (mirroring the C-02 migration for
 * the four low-risk blocks `divider`, `event`, `latex`,
 * `surface-ref`).
 *
 * This test verifies the same four properties for the
 * Mermaid migration:
 *
 * 1. The `@virgultum/block-mermaid` package exposes a
 *    `./manifest` subpath that resolves to a
 *    `FeatureManifest` with a non-empty `id`.
 * 2. The manifest contributes exactly one store
 *    extension (`MermaidStoreExtension`) and one view
 *    extension (`MermaidViewExtension`).
 * 3. The `publicExports` slot lists `./manifest`
 *    alongside the package's other entry-points
 *    (`./`, `./view`, `./store`).
 * 4. The id of the imported manifest matches the id the
 *    editor-aggregate registry knows under (so
 *    `INTERNAL_STORE_ORDER` / `INTERNAL_VIEW_ORDER`
 *    lookups hit the right entry), and the registry
 *    entry references the **same object** the block
 *    package exports (single source of truth).
 *
 * **Mermaid-specific invariant:** unlike the four C-02
 * migrations, the I-02 manifest also declares
 * `hostServices: []` (empty, but present). This
 * documents the I-01 inventory's finding that Mermaid
 * has no host-service consumer today (closes
 * I-PRE-FIND-05 Folge). A future `merman`-PDF-Export-
 * Trigger (Prio B) would add entries here; until then
 * the slot stays empty.
 *
 * The aggregate-wide "byte-for-byte equal to legacy"
 * test (the C-01 invariant) lives in
 * `manifest-consistency.unit.spec.ts` and is **not**
 * duplicated here.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-02 reference)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-01 inventory, I-02 closeout)
 */

import { mermaidManifest } from "@virgultum/block-mermaid/manifest";
import { describe, expect, test } from "vitest";

import { internalManifestRegistry } from "../manifest-registry";

describe("P-VIRG-ARCH-I-02 mermaid block manifest", () => {
  test("the aggregate registry has a manifest for the migrated mermaid block", () => {
    const inRegistry = internalManifestRegistry.manifests.some(
      (m) => (m.id as unknown as string) === "mermaid",
    );
    expect(
      inRegistry,
      `registry must contain a manifest for migrated block "mermaid" (id "mermaid")`,
    ).toBe(true);
  });

  test("the mermaid manifest is the same object the registry uses", () => {
    const inRegistry = internalManifestRegistry.byId.get(mermaidManifest.id);
    expect(
      inRegistry,
      `registry lookup by manifest.id must succeed for "mermaid"`,
    ).toBeDefined();
    // The registry entry should reference the same
    // manifest object the block package exports, so
    // the manifest lives in one place.
    expect(inRegistry).toBe(mermaidManifest);
    expect(inRegistry!.id as unknown as string).toBe("mermaid");
  });

  describe("per-package shape", () => {
    test(`mermaid: id is a non-empty string`, () => {
      expect(mermaidManifest.id).toBeTruthy();
      expect((mermaidManifest.id as unknown as string).length).toBeGreaterThan(
        0,
      );
    });

    test(`mermaid: contributes exactly one store extension`, () => {
      expect(mermaidManifest.store).toBeDefined();
      expect(mermaidManifest.store).toHaveLength(1);
    });

    test(`mermaid: contributes exactly one view extension`, () => {
      expect(mermaidManifest.view).toBeDefined();
      expect(mermaidManifest.view).toHaveLength(1);
    });

    test(`mermaid: publicExports lists the manifest entry-point`, () => {
      expect(mermaidManifest.publicExports).toBeDefined();
      expect(mermaidManifest.publicExports).toContain("./manifest");
      expect(mermaidManifest.publicExports).toContain("./view");
      expect(mermaidManifest.publicExports).toContain("./store");
      expect(mermaidManifest.publicExports).toContain(".");
    });

    test(`mermaid: hostServices slot is declared (empty array documents I-01 contract)`, () => {
      // I-01 inventory (Befund 3) found no hostServices
      // consumer in Mermaid. The slot is declared as an
      // empty array to document the contract; a future
      // merman PDF trigger (Prio B) would add entries
      // here. The C-03 manifest-slot-shape guard is
      // happy with an empty array as long as the field
      // is present.
      expect(mermaidManifest.hostServices).toBeDefined();
      expect(mermaidManifest.hostServices).toEqual([]);
    });

    test(`mermaid: testTags slot is declared (empty array, consistent with C-02 pattern)`, () => {
      expect(mermaidManifest.testTags).toBeDefined();
      expect(mermaidManifest.testTags).toEqual([]);
    });
  });
});
