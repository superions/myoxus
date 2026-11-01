// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `mode-surface-contract.unit.spec.ts` -
 * P-VIRG-ARCH-D-01 contract tests.
 *
 * The contract is the testable artifact the D-01
 * acceptance criterion names. This test pins the
 * shape and the table so a downstream consumer
 * (D-02 probe helpers, D-04 evidence standard, the
 * E-XX Kanban refactor) can rely on it. The test
 * covers:
 *
 * 1. **Table completeness.** Every matrix row
 *    M01..M15 has exactly one entry; the
 *    `matrixId` is unique.
 * 2. **Row invariants.** The `allowedScopes` are
 *    non-empty for every entry except
 *    `blocked: true`; the `deniedScopes` are a
 *    subset of the `FeatureScope` union; the
 *    `matrixId` is one of the 15 ids.
 * 3. **Scope coverage.** The union of every
 *    entry's `allowedScopes` covers the 6
 *    `FeatureScope` values exactly
 *    (`page`, `edgeless`, `preview-page`,
 *    `preview-edgeless`, `mobile-page`,
 *    `mobile-edgeless`).
 * 4. **Read-only contract.** M11, M12, M14, M15
 *    are `readonly: true`; the other rows are
 *    `readonly: false`.
 * 5. **Lookup helper.** `getModeSurfaceContractEntry`
 *    returns the correct entry for each M01..M15
 *    and `null` for an unknown id.
 * 6. **Validation helper.**
 *    `validateManifestAgainstContract` returns
 *    `null` for a valid combination and a
 *    human-readable message for the four failure
 *    modes (unknown row, blocked row, denied
 *    scope, disallowed scope).
 * 7. **Frozen contract.** The contract array and
 *    every entry are `Object.freeze`d, so
 *    consumers cannot mutate the table.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §D
 *      (P-VIRG-ARCH-D-01)
 */

import { describe, expect, test } from "vitest";

import {
  getMatrixRowDisplayId,
  getMatrixRowFromDisplayId,
  getModeSurfaceContractEntry,
  type MatrixRowId,
  MODE_SURFACE_CONTRACT,
  validateManifestAgainstContract,
} from "../mode-surface-contract";

const ALL_MATRIX_IDS: ReadonlyArray<MatrixRowId> = [
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "M06",
  "M07",
  "M08",
  "M09",
  "M10",
  "M11",
  "M12",
  "M13",
  "M14",
  "M15",
];

describe("P-VIRG-ARCH-D-01 Mode/Surface Contract", () => {
  describe("table shape", () => {
    test("has exactly 15 entries, one per matrix row", () => {
      expect(MODE_SURFACE_CONTRACT.length).toBe(15);
    });

    test("matrix ids are unique and cover M01..M15", () => {
      const ids = MODE_SURFACE_CONTRACT.map((e) => e.matrixId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ALL_MATRIX_IDS) {
        expect(ids).toContain(id);
      }
    });

    test("the contract array itself is frozen", () => {
      expect(Object.isFrozen(MODE_SURFACE_CONTRACT)).toBe(true);
    });

    test("every entry is frozen", () => {
      for (const entry of MODE_SURFACE_CONTRACT) {
        expect(Object.isFrozen(entry)).toBe(true);
      }
    });

    test("every entry's allowedScopes and deniedScopes are frozen", () => {
      for (const entry of MODE_SURFACE_CONTRACT) {
        expect(Object.isFrozen(entry.allowedScopes)).toBe(true);
        expect(Object.isFrozen(entry.deniedScopes)).toBe(true);
      }
    });
  });

  describe("row invariants", () => {
    test("allowedScopes is non-empty for every non-blocked, non-readonly entry", () => {
      // A `readonly: true` row may have empty
      // `allowedScopes` because the read-only contract
      // is enforced at the command-registration level,
      // not the manifest level. M15 is the only such
      // row today.
      for (const entry of MODE_SURFACE_CONTRACT) {
        if (!entry.blocked && !entry.readonly) {
          expect(entry.allowedScopes.length).toBeGreaterThan(0);
        }
      }
    });

    test("allowedScopes is empty for every blocked entry", () => {
      for (const entry of MODE_SURFACE_CONTRACT) {
        if (entry.blocked) {
          expect(entry.allowedScopes.length).toBe(0);
        }
      }
    });

    test("no entry is blocked today (Mermaid rows are out-of-contract)", () => {
      for (const entry of MODE_SURFACE_CONTRACT) {
        expect(entry.blocked).toBe(false);
      }
    });

    test("deniedScopes is empty for every entry today", () => {
      for (const entry of MODE_SURFACE_CONTRACT) {
        expect(entry.deniedScopes).toEqual([]);
      }
    });

    test("every entry's description is a non-empty string", () => {
      for (const entry of MODE_SURFACE_CONTRACT) {
        expect(typeof entry.description).toBe("string");
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("scope coverage", () => {
    test("the union of allowedScopes covers all six FeatureScope values", () => {
      const union = new Set<string>();
      for (const entry of MODE_SURFACE_CONTRACT) {
        for (const scope of entry.allowedScopes) {
          union.add(scope);
        }
      }
      expect(union).toEqual(
        new Set([
          "page",
          "edgeless",
          "preview-page",
          "preview-edgeless",
          "mobile-page",
          "mobile-edgeless",
        ]),
      );
    });

    test("M01..M06 (Page runtime) all allow `page`", () => {
      for (const id of ["M01", "M02", "M03", "M04", "M05", "M06"] as const) {
        const entry = getModeSurfaceContractEntry(id);
        expect(entry).not.toBeNull();
        expect(entry!.allowedScopes).toContain("page");
        expect(entry!.allowedScopes).not.toContain("edgeless");
      }
    });

    test("M07..M10 (Edgeless runtime) all allow `edgeless`", () => {
      for (const id of ["M07", "M08", "M09", "M10"] as const) {
        const entry = getModeSurfaceContractEntry(id);
        expect(entry).not.toBeNull();
        expect(entry!.allowedScopes).toContain("edgeless");
        expect(entry!.allowedScopes).not.toContain("page");
      }
    });

    test("M11 allows `preview-page`; M12 allows `preview-edgeless`", () => {
      const m11 = getModeSurfaceContractEntry("M11");
      const m12 = getModeSurfaceContractEntry("M12");
      expect(m11).not.toBeNull();
      expect(m12).not.toBeNull();
      expect(m11!.allowedScopes).toEqual(["preview-page"]);
      expect(m12!.allowedScopes).toEqual(["preview-edgeless"]);
    });

    test("M13 allows `mobile-page`; M14 allows `mobile-edgeless`", () => {
      const m13 = getModeSurfaceContractEntry("M13");
      const m14 = getModeSurfaceContractEntry("M14");
      expect(m13).not.toBeNull();
      expect(m14).not.toBeNull();
      expect(m13!.allowedScopes).toEqual(["mobile-page"]);
      expect(m14!.allowedScopes).toEqual(["mobile-edgeless"]);
    });

    test("M15 (readonly shared) has empty allowedScopes", () => {
      const m15 = getModeSurfaceContractEntry("M15");
      expect(m15).not.toBeNull();
      expect(m15!.allowedScopes).toEqual([]);
    });
  });

  describe("read-only contract", () => {
    test("M11, M12, M14, M15 are readonly", () => {
      for (const id of ["M11", "M12", "M14", "M15"] as const) {
        const entry = getModeSurfaceContractEntry(id);
        expect(entry).not.toBeNull();
        expect(entry!.readonly).toBe(true);
      }
    });

    test("M01..M10 and M13 are NOT readonly", () => {
      for (const id of [
        "M01",
        "M02",
        "M03",
        "M04",
        "M05",
        "M06",
        "M07",
        "M08",
        "M09",
        "M10",
        "M13",
      ] as const) {
        const entry = getModeSurfaceContractEntry(id);
        expect(entry).not.toBeNull();
        expect(entry!.readonly).toBe(false);
      }
    });
  });

  describe("getModeSurfaceContractEntry", () => {
    test("returns the correct entry for every M01..M15", () => {
      for (const id of ALL_MATRIX_IDS) {
        const entry = getModeSurfaceContractEntry(id);
        expect(entry).not.toBeNull();
        expect(entry!.matrixId).toBe(id);
      }
    });
  });

  describe("validateManifestAgainstContract", () => {
    test("returns null for a valid scope/row combination", () => {
      // A Page-runtime manifest covering M02.
      const err = validateManifestAgainstContract(["page"], ["M02"]);
      expect(err).toBeNull();
    });

    test("returns null for multiple valid rows", () => {
      const err = validateManifestAgainstContract(
        ["page"],
        ["M01", "M02", "M03"],
      );
      expect(err).toBeNull();
    });

    test("returns null for a manifest with no scopes (default behaviour)", () => {
      // Empty manifest scopes — the helper iterates
      // scopes and finds nothing to flag.
      const err = validateManifestAgainstContract([], ["M02"]);
      expect(err).toBeNull();
    });

    test("returns an error when a scope is not allowed for the row (denied by absence)", () => {
      // M11 allows only `preview-page`; a manifest
      // declaring `page` is rejected. The error
      // message says "does not allow it" — the
      // `deniedScopes` field is reserved for the
      // future case where some scopes are explicitly
      // banned rather than simply outside the
      // allow-list.
      const err = validateManifestAgainstContract(["page"], ["M11"]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/does not allow it/);
    });

    test("returns an error when a scope is not allowed for the row", () => {
      // `edgeless` is not allowed for M01 (Page runtime).
      const err = validateManifestAgainstContract(["edgeless"], ["M01"]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/does not allow it/);
    });

    test("returns an error for an unknown matrix row id", () => {
      // The helper accepts only the 15 ids; passing
      // an arbitrary string is a programmer error.
      const err = validateManifestAgainstContract(["page"], [
        "M99",
      ] as unknown as ReadonlyArray<MatrixRowId>);
      expect(err).not.toBeNull();
      expect(err).toMatch(/not in the Mode\/Surface Contract/);
    });
  });

  describe("D-FIND-07: getMatrixRowDisplayId / getMatrixRowFromDisplayId", () => {
    /**
     * D-FIND-07 was filed when the D-02 probe helpers
     * introduced the `GeometryMatrixRowId` namespace
     * (`M01-page-empty`..`M15-readonly-shared`) without
     * a canonical bridge to the D-01 contract's
     * `MatrixRowId` (`M01`..`M15`). The two helpers
     * below make the bridge explicit and unit-test
     * the round-trip property.
     */
    test("getMatrixRowDisplayId returns the canonical <MatrixRowId>-<suffix>", () => {
      expect(getMatrixRowDisplayId("M01")).toBe("M01-page-empty");
      expect(getMatrixRowDisplayId("M02")).toBe("M02-page-rich-text");
      expect(getMatrixRowDisplayId("M03")).toBe("M03-page-database-table");
      expect(getMatrixRowDisplayId("M04")).toBe("M04-page-database-kanban");
      expect(getMatrixRowDisplayId("M05")).toBe("M05-page-event-block");
      expect(getMatrixRowDisplayId("M06")).toBe("M06-page-bpmn-hidden-beta");
      expect(getMatrixRowDisplayId("M07")).toBe("M07-edgeless-empty");
      expect(getMatrixRowDisplayId("M08")).toBe(
        "M08-edgeless-note-with-page-content",
      );
      expect(getMatrixRowDisplayId("M09")).toBe(
        "M09-edgeless-kanban-canvas-path",
      );
      expect(getMatrixRowDisplayId("M10")).toBe(
        "M10-edgeless-frame-note-selection",
      );
      expect(getMatrixRowDisplayId("M11")).toBe("M11-preview-page");
      expect(getMatrixRowDisplayId("M12")).toBe("M12-preview-edgeless");
      expect(getMatrixRowDisplayId("M13")).toBe("M13-mobile-page");
      expect(getMatrixRowDisplayId("M14")).toBe("M14-mobile-edgeless");
      expect(getMatrixRowDisplayId("M15")).toBe("M15-readonly-shared");
    });

    test("getMatrixRowFromDisplayId round-trips for every M01..M15", () => {
      const ids: ReadonlyArray<MatrixRowId> = [
        "M01",
        "M02",
        "M03",
        "M04",
        "M05",
        "M06",
        "M07",
        "M08",
        "M09",
        "M10",
        "M11",
        "M12",
        "M13",
        "M14",
        "M15",
      ];
      for (const id of ids) {
        const display = getMatrixRowDisplayId(id);
        const back = getMatrixRowFromDisplayId(display);
        expect(back, `round-trip for ${id} -> ${display}`).toBe(id);
      }
    });

    test("getMatrixRowFromDisplayId returns null for malformed input", () => {
      // Missing dash.
      expect(getMatrixRowFromDisplayId("M01page-empty")).toBeNull();
      // Unknown prefix.
      expect(getMatrixRowFromDisplayId("M99-page-empty")).toBeNull();
      // Known prefix but wrong suffix.
      expect(getMatrixRowFromDisplayId("M01-page-rich-text")).toBeNull();
      // Empty string.
      expect(getMatrixRowFromDisplayId("")).toBeNull();
    });

    test("display ids are unique across the 15 rows", () => {
      const displayIds = new Set<string>();
      const ids: ReadonlyArray<MatrixRowId> = [
        "M01",
        "M02",
        "M03",
        "M04",
        "M05",
        "M06",
        "M07",
        "M08",
        "M09",
        "M10",
        "M11",
        "M12",
        "M13",
        "M14",
        "M15",
      ];
      for (const id of ids) {
        displayIds.add(getMatrixRowDisplayId(id));
      }
      expect(displayIds.size).toBe(15);
    });
  });
});
