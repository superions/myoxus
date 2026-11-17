// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `mode-surface-contract.ts` - the `P-VIRG-ARCH-D-01`
 * Mode/Surface Contract.
 *
 * As of D-01, every feature that contributes a
 * `FeatureManifest` to the editor aggregate declares
 * the surfaces it is registered for via
 * `manifest.scopes`. The surfaces are:
 *
 * - `page` — the runtime Page mode (M01..M06).
 * - `edgeless` — the runtime Edgeless mode (M07..M10).
 * - `preview-page` — a read-only Page render in a
 *   shared-link / embed context (M11).
 * - `preview-edgeless` — a read-only Edgeless render
 *   in a shared-link / embed context (M12).
 * - `mobile-page` — the mobile-shell Page render
 *   (M13).
 * - `mobile-edgeless` — the mobile-shell Edgeless
 *   render (M14).
 *
 * Matrix row M15 (`readonly-shared`) is **not** a
 * `FeatureScope` because the read-only contract is
 * enforced at the command-registration level, not the
 * extension-registration level. A shared-link
 * rendering uses the same `page` / `edgeless`
 * manifests as the runtime rendering; the host
 * disables edit commands.
 *
 * The `ModeSurfaceContractEntry` array below is the
 * authoritative table that names, for every matrix
 * row, which `FeatureScope` values are allowed. The
 * table is **frozen** at module load time; downstream
 * code can pass it around freely.
 *
 * The contract is the testable artifact the D-01
 * acceptance criterion names: a downstream consumer
 * (the D-02 probe helpers, the D-04 evidence
 * standard, the E-XX Kanban refactor) reads the
 * contract to ask "for matrix row M09, which scopes
 * are allowed?" The test in
 * `__tests__/mode-surface-contract.unit.spec.ts`
 * pins the contract: every matrix row M01..M15 has
 * exactly one entry; the `allowedScopes` are
 * non-empty for every entry except `blocked`; the
 * `matrixId` is unique.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §11
 *      (Verhaltensmatrix M01..M15)
 * @see docs/dev/virgultum/refactor-roadmap.md §D
 *      (P-VIRG-ARCH-D-01)
 */

import type { FeatureScope } from "./feature-manifest";

/**
 * Matrix row identifier. The 15 rows M01..M15 are the
 * stable identifier the C-04 scope report, the
 * `FeatureManifest.scopes`, and every closeout
 * reference. The branded-string type prevents a
 * typo from compiling.
 */
export type MatrixRowId =
  | "M01"
  | "M02"
  | "M03"
  | "M04"
  | "M05"
  | "M06"
  | "M07"
  | "M08"
  | "M09"
  | "M10"
  | "M11"
  | "M12"
  | "M13"
  | "M14"
  | "M15";

/**
 * One row in the Mode/Surface Contract. The fields
 * are the testable contract: a feature whose
 * `manifest.scopes` is **not** a subset of
 * `allowedScopes` is in violation; a feature whose
 * `manifest.scopes` does include any of
 * `deniedScopes` is in violation; the `description`
 * is the human-readable summary.
 *
 * `blocked: true` is reserved for matrix rows that
 * the D-01 contract **forbids entirely** (none
 * today; the field is here for Mermaid, which
 * remains locked out until P-VIRG-ARCH-I). When
 * `blocked: true`, `allowedScopes` is `[]` and the
 * test enforces that no manifest can carry this
 * matrix row.
 */
export interface ModeSurfaceContractEntry {
  /** Stable matrix row id. */
  readonly matrixId: MatrixRowId;
  /**
   * Human-readable description. Mirrors the "Setup"
   * column of `refactor-roadmap.md` §11.
   */
  readonly description: string;
  /**
   * The `FeatureScope` values a feature is allowed
   * to declare for this matrix row. The
   * `allowedScopes` of every entry together form the
   * union every feature manifest's `scopes` field
   * must be a subset of (modulo the default
   * `["page", "edgeless"]`).
   */
  readonly allowedScopes: ReadonlyArray<FeatureScope>;
  /**
   * The `FeatureScope` values that are explicitly
   * **denied** for this matrix row. A feature whose
   * `manifest.scopes` includes any of `deniedScopes`
   * is in violation. Most rows have an empty
   * `deniedScopes`.
   */
  readonly deniedScopes: ReadonlyArray<FeatureScope>;
  /**
   * Whether the matrix row is blocked entirely. When
   * `true`, `allowedScopes` is empty and no feature
   * may declare this row. Today no row is blocked;
   * the Mermaid rows are out of scope of this
   * contract (they're listed in
   * `refactor-roadmap.md` §2 `blocked-mermaid-scope`).
   */
  readonly blocked: boolean;
  /**
   * Whether the rendering for this row is read-only
   * by contract. Read-only does NOT change the
   * `FeatureScope` set; it is enforced at the
   * command-registration level. Used by M11, M12,
   * and M15.
   */
  readonly readonly: boolean;
}

/**
 * The authoritative Mode/Surface Contract. Mirrors
 * `refactor-roadmap.md` §11 one-to-one; the test
 * pins the table.
 *
 * **Reading the table.**
 * - M01..M06: `page` (runtime). All authoring
 *   features for the Page mode declare
 *   `scopes: ["page"]` (or omit `scopes` entirely
 *   and inherit the default `["page", "edgeless"]`
 *   — but a Page-only feature should declare the
 *   narrower scope).
 * - M07..M10: `edgeless` (runtime). The Edgeless-
 *   specific features (frame-title, edgeless-toolbar,
 *   gfx-pointer, gfx-shape, ...) declare
 *   `scopes: ["edgeless"]`.
 * - M11: `preview-page`. Read-only Page rendering
 *   in a shared-link / embed context. The feature
 *   declares `scopes: ["preview-page"]` and the
 *   host disables edit commands.
 * - M12: `preview-edgeless`. Read-only Edgeless
 *   rendering. `scopes: ["preview-edgeless"]`.
 * - M13: `mobile-page`. Mobile-shell Page render.
 *   `scopes: ["mobile-page"]`. **No feature
 *   declares this today** (C-FIND-11) — the
 *   `scope-report.unit.spec.ts` test in
 *   `editor/all` documents the gap.
 * - M14: `mobile-edgeless`. Mobile-shell Edgeless
 *   render. `scopes: ["mobile-edgeless"]`. Same
 *   gap as M13.
 * - M15: `readonly` (shared). Enforced at the
 *   command-registration level; the feature
 *   manifest's `scopes` field is unaffected.
 */
export const MODE_SURFACE_CONTRACT: ReadonlyArray<ModeSurfaceContractEntry> =
  Object.freeze([
    Object.freeze({
      matrixId: "M01" as MatrixRowId,
      description: "Page-Doc with `root` and 0 children",
      allowedScopes: Object.freeze(["page"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M02" as MatrixRowId,
      description: "Page-Doc with rich-text blocks",
      allowedScopes: Object.freeze(["page"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M03" as MatrixRowId,
      description: "Page-Doc with `myoxus:database` table view",
      allowedScopes: Object.freeze(["page"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M04" as MatrixRowId,
      description: "Page-Doc with database-block kanban view",
      allowedScopes: Object.freeze(["page"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M05" as MatrixRowId,
      description: "Page-Doc with `virgultum:event` block",
      allowedScopes: Object.freeze(["page"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M06" as MatrixRowId,
      description: "Page-Doc with `virgultum:bpmn` block (feature flag on)",
      allowedScopes: Object.freeze(["page"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M07" as MatrixRowId,
      description: "Edgeless-Doc with `root` and empty surface",
      allowedScopes: Object.freeze(["edgeless"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M08" as MatrixRowId,
      description: "Edgeless-Doc with note in `PageContent` display mode",
      allowedScopes: Object.freeze(["edgeless"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M09" as MatrixRowId,
      description: "Edgeless-Doc with note/frame containing database-kanban",
      allowedScopes: Object.freeze(["edgeless"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M10" as MatrixRowId,
      description: "Edgeless-Doc with >=2 notes in >=1 frame",
      allowedScopes: Object.freeze(["edgeless"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M11" as MatrixRowId,
      description: "Page-Doc in preview/embed context, read-only",
      allowedScopes: Object.freeze(["preview-page"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: true,
    }),
    Object.freeze({
      matrixId: "M12" as MatrixRowId,
      description: "Edgeless-Doc in preview context, read-only",
      allowedScopes: Object.freeze(["preview-edgeless"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: true,
    }),
    Object.freeze({
      matrixId: "M13" as MatrixRowId,
      description: "Page-Doc in mobile viewport (<=640 px)",
      allowedScopes: Object.freeze(["mobile-page"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: false,
    }),
    Object.freeze({
      matrixId: "M14" as MatrixRowId,
      description: "Edgeless-Doc in mobile viewport",
      allowedScopes: Object.freeze(["mobile-edgeless"] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: true,
    }),
    Object.freeze({
      matrixId: "M15" as MatrixRowId,
      description: "Doc via shared-link, `mode=readonly`",
      allowedScopes: Object.freeze([] as const),
      deniedScopes: Object.freeze([] as const),
      blocked: false,
      readonly: true,
    }),
  ]);

/**
 * Look up the contract entry for a given matrix row.
 * Returns `null` if the row is not in the contract
 * (should never happen for M01..M15; the test pins
 * the table).
 */
export function getModeSurfaceContractEntry(
  matrixId: MatrixRowId,
): ModeSurfaceContractEntry | null {
  for (const entry of MODE_SURFACE_CONTRACT) {
    if (entry.matrixId === matrixId) {
      return entry;
    }
  }
  return null;
}

/**
 * Validate that a feature manifest's `scopes` are
 * consistent with the matrix rows it claims to
 * cover. Today the manifest does not carry a matrix
 * row id, so this helper is reserved for a
 * future-phase integration (the C-04 scope report
 * already validates the runtime scope; this helper
 * extends the validation to the contract table).
 *
 * Returns `null` on success or a human-readable
 * error message on the first violation found.
 */
export function validateManifestAgainstContract(
  manifestScopes: ReadonlyArray<FeatureScope>,
  contractMatrixIds: ReadonlyArray<MatrixRowId>,
): string | null {
  for (const id of contractMatrixIds) {
    const entry = getModeSurfaceContractEntry(id);
    if (!entry) {
      return `matrix row ${id} is not in the Mode/Surface Contract`;
    }
    if (entry.blocked) {
      return `matrix row ${id} is blocked; no manifest may cover it`;
    }
    for (const scope of manifestScopes) {
      if (entry.deniedScopes.includes(scope)) {
        return (
          `manifest declares scope "${scope}" but matrix row ${id} ` +
          `denies it`
        );
      }
      if (
        entry.allowedScopes.length > 0 &&
        !entry.allowedScopes.includes(scope)
      ) {
        return (
          `manifest declares scope "${scope}" but matrix row ${id} ` +
          `does not allow it (allowed: ${entry.allowedScopes.join(", ")})`
        );
      }
    }
  }
  return null;
}

/**
 * The display suffix for each `MatrixRowId`. The
 * concatenation `<MatrixRowId>-<displaySuffix>` is
 * the `GeometryMatrixRowId` used by the D-02 probe
 * helpers. D-FIND-07 (P-VIRG-ARCH-D-04 follow-up)
 * centralises the suffix list here so the
 * geometry-assert module can derive the
 * `GeometryMatrixRowId` from a `MatrixRowId` (and
 * vice versa) without duplication.
 *
 * The table mirrors the
 * `GeometryMatrixRowId` union in
 * `mode-surface-geometry-assert.ts`. The contract
 * test pins the 1:1 correspondence: any future
 * matrix row has to add an entry here and the
 * geometry-assert union has to add a corresponding
 * literal.
 */
const MATRIX_ROW_DISPLAY_SUFFIX: Readonly<Record<MatrixRowId, string>> =
  Object.freeze({
    M01: "page-empty",
    M02: "page-rich-text",
    M03: "page-database-table",
    M04: "page-database-kanban",
    M05: "page-event-block",
    M06: "page-bpmn-hidden-beta",
    M07: "edgeless-empty",
    M08: "edgeless-note-with-page-content",
    M09: "edgeless-kanban-canvas-path",
    M10: "edgeless-frame-note-selection",
    M11: "preview-page",
    M12: "preview-edgeless",
    M13: "mobile-page",
    M14: "mobile-edgeless",
    M15: "readonly-shared",
  });

/**
 * Get the `GeometryMatrixRowId` display id for a
 * given `MatrixRowId`. The display id is the
 * `<MatrixRowId>-<descriptor>` string the D-02 probe
 * harness and the D-04 evidence manifest use to
 * identify a row in test artefacts.
 *
 * D-FIND-07: before this helper existed, the two
 * matrix-id namespaces (the contract's `M01`..`M15`
 * and the geometry-assert's `M01-page-empty`..)
 * were not formally bridged — a consumer had to
 * duplicate the suffix list. The helper makes the
 * mapping canonical.
 *
 * The return type is `string` rather than the
 * `GeometryMatrixRowId` union because the contract
 * module is the **leaf** of the geometry-assert
 * dependency chain (geometry-assert imports from
 * the contract). Forwarding the union would create
 * a circular import. The geometry-assert module
 * provides a complementary `parseGeometryMatrixRowId`
 * that performs the same mapping and narrows the
 * result back to the union.
 */
export function getMatrixRowDisplayId(matrixId: MatrixRowId): string {
  const suffix = MATRIX_ROW_DISPLAY_SUFFIX[matrixId];
  return `${matrixId}-${suffix}`;
}

/**
 * Get the canonical `MatrixRowId` for a given
 * `GeometryMatrixRowId` display id. The reverse
 * direction of `getMatrixRowDisplayId`. Returns
 * `null` if the display id does not match the
 * `<MatrixRowId>-<suffix>` convention.
 *
 * The display id MUST start with `M01`..`M15` and
 * the suffix MUST match the canonical suffix from
 * `MATRIX_ROW_DISPLAY_SUFFIX`; otherwise the input
 * is not a known display id and the helper returns
 * `null` (caller decides whether to throw or to
 * log).
 */
export function getMatrixRowFromDisplayId(
  displayId: string,
): MatrixRowId | null {
  // The display id has the shape `M<NN>-<suffix>`.
  // We split on the first `-` so multi-dash suffixes
  // (none today) keep working.
  const dash = displayId.indexOf("-");
  if (dash < 0) return null;
  const prefix = displayId.slice(0, dash);
  const suffix = displayId.slice(dash + 1);
  // `MatrixRowId` is a string-literal union; we
  // verify the prefix is one of the 15 known rows.
  const known = (
    Object.keys(MATRIX_ROW_DISPLAY_SUFFIX) as ReadonlyArray<MatrixRowId>
  ).find((id) => id === prefix);
  if (!known) return null;
  if (MATRIX_ROW_DISPLAY_SUFFIX[known] !== suffix) return null;
  return known;
}
