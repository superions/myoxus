// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseChangeEventPayload } from "../presence";

export const DatabaseChangeReasonKind = {
  DatabaseCreated: "database_created",
  DatabaseUpdated: "database_updated",
  DatabaseTrashed: "database_trashed",
  DatabaseRestored: "database_restored",
  DatabaseDeleted: "database_deleted",
  RowCreated: "row_created",
  RowUpdated: "row_updated",
  RowDeleted: "row_deleted",
  RowRestored: "row_restored",
  RowMoved: "row_moved",
  CellUpdated: "cell_updated",
  FieldCreated: "field_created",
  FieldUpdated: "field_updated",
  FieldDeleted: "field_deleted",
  FieldReordered: "field_reordered",
  ViewCreated: "view_created",
  ViewUpdated: "view_updated",
  ViewReordered: "view_reordered",
  ViewDeleted: "view_deleted",
  ViewResultUpdated: "view_result_updated",
  RowTemplateCreated: "row_template_created",
  RowTemplateUpdated: "row_template_updated",
  RowTemplateDeleted: "row_template_deleted",
  StructureUpdated: "structure_updated",
  BulkImported: "bulk_imported",
  BulkExported: "bulk_exported",
  FullReload: "full_reload",
} as const;

export type DatabaseChangeReasonKind =
  (typeof DatabaseChangeReasonKind)[keyof typeof DatabaseChangeReasonKind];

export interface DatabaseChangeReason {
  kind: DatabaseChangeReasonKind;
  target?: {
    rowId?: string;
    fieldId?: string;
    viewId?: string;
  } | null;
}

export type DatabaseChangeInput =
  DatabaseChangeReason | Pick<DatabaseChangeEventPayload, "kind" | "target">;

export type DatabaseChangeHandler = (
  reason?: DatabaseChangeReason,
) => Promise<void>;

export interface DatabaseChangeImpact {
  activeView: boolean;
  inventory: boolean;
  linkedRow: boolean;
  rowTemplates: boolean;
  rows: boolean;
  scheduleRows: boolean;
  schema: boolean;
  viewSummaries: boolean;
}

const NO_IMPACT: DatabaseChangeImpact = {
  activeView: false,
  inventory: false,
  linkedRow: false,
  rowTemplates: false,
  rows: false,
  scheduleRows: false,
  schema: false,
  viewSummaries: false,
};

const FULL_IMPACT: DatabaseChangeImpact = {
  activeView: true,
  inventory: true,
  linkedRow: true,
  rowTemplates: true,
  rows: true,
  scheduleRows: true,
  schema: true,
  viewSummaries: true,
};

/**
 * Maps local mutation outcomes and remote change events to the query families
 * whose server projections can change. Unknown events deliberately retain the
 * previous full-refresh behavior.
 */
export function databaseChangeImpact(
  change: DatabaseChangeInput,
): DatabaseChangeImpact {
  switch (change.kind) {
    case DatabaseChangeReasonKind.CellUpdated:
    case DatabaseChangeReasonKind.RowUpdated:
    case DatabaseChangeReasonKind.RowMoved:
      return {
        ...NO_IMPACT,
        linkedRow: true,
        rows: true,
        scheduleRows: true,
      };
    case DatabaseChangeReasonKind.RowCreated:
    case DatabaseChangeReasonKind.RowDeleted:
    case DatabaseChangeReasonKind.RowRestored:
      return {
        ...NO_IMPACT,
        inventory: true,
        linkedRow: true,
        rows: true,
        scheduleRows: true,
      };
    case DatabaseChangeReasonKind.FieldCreated:
    case DatabaseChangeReasonKind.FieldUpdated:
    case DatabaseChangeReasonKind.FieldDeleted:
    case DatabaseChangeReasonKind.FieldReordered:
      return {
        ...NO_IMPACT,
        linkedRow: true,
        rows: true,
        scheduleRows: true,
        schema: true,
      };
    case DatabaseChangeReasonKind.ViewCreated:
    case DatabaseChangeReasonKind.ViewUpdated:
    case DatabaseChangeReasonKind.ViewReordered:
    case DatabaseChangeReasonKind.ViewDeleted:
      return {
        ...NO_IMPACT,
        activeView: true,
        rows: true,
        scheduleRows: true,
        viewSummaries: true,
      };
    case DatabaseChangeReasonKind.ViewResultUpdated:
      return { ...NO_IMPACT, rows: true, scheduleRows: true };
    case DatabaseChangeReasonKind.RowTemplateCreated:
    case DatabaseChangeReasonKind.RowTemplateUpdated:
    case DatabaseChangeReasonKind.RowTemplateDeleted:
      return { ...NO_IMPACT, rowTemplates: true };
    case DatabaseChangeReasonKind.StructureUpdated:
      return {
        ...NO_IMPACT,
        activeView: true,
        linkedRow: true,
        rows: true,
        scheduleRows: true,
        schema: true,
        viewSummaries: true,
      };
    case DatabaseChangeReasonKind.DatabaseCreated:
    case DatabaseChangeReasonKind.DatabaseUpdated:
    case DatabaseChangeReasonKind.DatabaseTrashed:
    case DatabaseChangeReasonKind.DatabaseRestored:
    case DatabaseChangeReasonKind.DatabaseDeleted:
      return { ...NO_IMPACT, inventory: true, schema: true };
    case DatabaseChangeReasonKind.BulkExported:
      return NO_IMPACT;
    case DatabaseChangeReasonKind.BulkImported:
    case DatabaseChangeReasonKind.FullReload:
      return FULL_IMPACT;
    default:
      return FULL_IMPACT;
  }
}
