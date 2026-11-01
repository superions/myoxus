// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `mode-surface-contract.ts` - the editor-aggregate
 * re-export of the `P-VIRG-ARCH-D-01` Mode/Surface
 * Contract.
 *
 * As of D-01, the canonical contract lives in
 * `@virgultum/ext-loader` (a leaf package every
 * block already depends on). This file re-exports
 * the contract types and helpers so consumers can
 * import them from
 * `@virgultum/editor/extensions/mode-surface-contract`
 * — the same shape every other C-XX artifact uses.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §D
 *      (P-VIRG-ARCH-D-01)
 */

export {
  getModeSurfaceContractEntry,
  type MatrixRowId,
  MODE_SURFACE_CONTRACT,
  type ModeSurfaceContractEntry,
  validateManifestAgainstContract,
} from "@virgultum/ext-loader/mode-surface-contract";
