// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Myoxus-owned Database Table types (P-DB-29B-B).
//
// These types are the contract between the active Table surface
// (`DatabaseTableView` in `../table/view.tsx`) and the surrounding
// `DatabaseViewHost`. They deliberately do NOT extend
// or import from any legacy data-view preset module; every field
// is a plain serialisable shape so the active Table component can
// render it without referencing external preset types.

import type { DatabaseFieldKind } from "@myoxus/graphql";

import type { DatabaseRowRecord } from "../types";

export interface DatabaseTableFieldDescriptor {
  readonly id: string;
  readonly fieldType: DatabaseFieldKind;
  readonly label: string;
  /** Mirrors the `com.myoxus.database.field.type.<kind>` i18n label. */
  readonly typeLabel: string;
  readonly readonly: boolean;
  readonly unsupported: boolean;
  /** Persisted column width (px) when the user has resized the column. */
  readonly width: number | null;
  /** Effective P-DB-22 sort state, including personal overrides. */
  readonly sortDirection: "asc" | "desc" | null;
  /** One-based priority in the effective multi-sort contract. */
  readonly sortPriority: number | null;
}

export interface DatabaseTableRowDescriptor {
  readonly id: string;
  readonly title: string;
  /** Actor-safe metadata for the Row's optional, independently owned content. */
  readonly contentDocument: DatabaseRowRecord["row"]["contentDocument"];
  readonly redacted: boolean;
}

export interface DatabaseTableRowTemplateDescriptor {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly isDefault: boolean;
}

export interface DatabaseTableFieldTypeLabels {
  readonly Checkbox: string;
  readonly CreatedBy: string;
  readonly CreatedTime: string;
  readonly Date: string;
  readonly DateTime: string;
  readonly Email: string;
  readonly Files: string;
  readonly UniqueId: string;
  readonly Formula: string;
  readonly MultiSelect: string;
  readonly Tags: string;
  readonly Status: string;
  readonly Number: string;
  readonly Percent: string;
  readonly Currency: string;
  readonly Duration: string;
  readonly Phone: string;
  readonly Relation: string;
  readonly RichText: string;
  readonly Rollup: string;
  readonly Select: string;
  readonly Text: string;
  readonly Title: string;
  readonly UpdatedBy: string;
  readonly UpdatedTime: string;
  readonly Url: string;
  readonly User: string;
  readonly Users: string;
  readonly Unsupported: string;
}

export interface DatabaseTableLabels {
  readonly cancel: string;
  readonly bulkActionsTitle: string;
  readonly bulkEdit: string;
  readonly bulkDelete: string;
  readonly bulkDeleteConfirmBody: string;
  readonly bulkDeleteConfirmConfirm: string;
  readonly bulkDeleteConfirmTitle: (count: number) => string;
  readonly bulkExportSelected: string;
  readonly bulkSelectedCount: (count: number) => string;
  readonly clearSelection: string;
  readonly createField: string;
  readonly databaseMenu: string;
  readonly deleteField: string;
  readonly deleteRow: string;
  readonly emptyRows: string;
  readonly fieldCreateValidation: string;
  readonly fieldConfigure: string;
  readonly fieldName: string;
  readonly fieldPlus: string;
  readonly fieldMoveLeft: string;
  readonly fieldMoveRight: string;
  readonly fieldReorder: string;
  readonly fieldResize: string;
  readonly fieldType: string;
  readonly manageRowTemplates: string;
  readonly newRow: string;
  readonly openRowDetails: string;
  readonly rowMenu: string;
  readonly selectAllRows: string;
  readonly selectRow: string;
  readonly sortAscending: string;
  readonly sortDescending: string;
  readonly unsupportedField: string;
  readonly useEmptyRow: string;
  readonly viewMenu: string;
}

/** Stable field kind identifier for the Table view surface. */
export type DatabaseTableFieldKindName = DatabaseFieldKind | "Unsupported";
