// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: shared conflict payload contract for the Database
// collaboration surface.
//
// The server emits the conflict payload as the `latestState` GraphQL
// extension when `preconditionVersion` fails (see
// `server/crates/application/src/database/mod.rs`). The shape is a
// stringified JSON object: the client parses it on modal open and
// re-renders the conflicting cell / row / field so the user can
// decide whether to reload the latest or force-overwrite their own
// value.
//
// Keeping the parser in its own file avoids re-importing the service
// module when only the types are needed (e.g. mock factories).

import type { DatabasePresenceRecord } from "./service";

export interface DatabaseConflictLatestStateCell {
  kind: "cell";
  databaseId: string;
  rowId: string;
  fieldId: string;
  fieldKind: string | null;
  editRevision: number;
  value: unknown;
  displayValue: string | null;
  attemptedValue?: unknown;
}

export interface DatabaseConflictLatestStateRow {
  kind: "row";
  databaseId: string;
  rowId: string;
  editRevision: number;
  title: string | null;
}

export interface DatabaseConflictLatestStateField {
  kind: "field";
  databaseId: string;
  fieldId: string;
  editRevision: number;
  name: string | null;
}

export interface DatabaseConflictLatestStateView {
  kind: "view";
  databaseId: string;
  viewId: string;
  editRevision: number;
  name: string | null;
}

export interface DatabaseConflictLatestStateOrder {
  kind: "field_order" | "view_order";
  databaseId: string;
  fields?: unknown[];
  views?: unknown[];
}

export interface DatabaseConflictLatestStateBulk {
  kind: "bulk";
  databaseId: string;
  conflicts?: unknown[];
  targets?: unknown[];
}

export interface DatabaseConflictLatestStateDatabase {
  kind: "database";
  databaseId: string;
  editRevision: number;
  title: string | null;
}

export interface DatabaseConflictLatestStateRowTemplate {
  kind: "rowTemplate";
  databaseId: string;
  rowTemplateId: string;
  editRevision: number;
  name: string | null;
  initialCellValues: unknown;
}

export type DatabaseConflictLatestState =
  | DatabaseConflictLatestStateRowTemplate
  | DatabaseConflictLatestStateCell
  | DatabaseConflictLatestStateRow
  | DatabaseConflictLatestStateField
  | DatabaseConflictLatestStateView
  | DatabaseConflictLatestStateOrder
  | DatabaseConflictLatestStateBulk
  | DatabaseConflictLatestStateDatabase;

export const DATABASE_CONFLICT_ERROR_CODES = [
  "MIX_DATABASE_CONFLICT",
  "MIX_DATABASE_CELL_CONFLICT",
  "MIX_DATABASE_ROW_CONFLICT",
  "MIX_DATABASE_FIELD_CONFLICT",
  "MIX_DATABASE_VIEW_CONFLICT",
  "MIX_DATABASE_BULK_CONFLICT",
] as const;

export type DatabaseConflictErrorCode =
  (typeof DATABASE_CONFLICT_ERROR_CODES)[number];

/**
 * Parse the `latestState` JSON payload off a conflict GraphQL error.
 * Returns `null` when the payload is missing, malformed, or not one of
 * the registered conflict kinds. The modal uses the `null` result to
 * render a generic "stale write detected" copy instead of a focused
 * diff.
 */
export function parseDatabaseConflictLatestState(
  raw: string | null | undefined,
): DatabaseConflictLatestState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const kind = parsed.kind;
    if (typeof parsed.databaseId !== "string") return null;
    if (kind === "cell") {
      if (
        typeof parsed.rowId !== "string" ||
        typeof parsed.fieldId !== "string"
      ) {
        return null;
      }
      return {
        kind: "cell",
        databaseId: parsed.databaseId,
        rowId: parsed.rowId,
        fieldId: parsed.fieldId,
        fieldKind:
          typeof parsed.fieldKind === "string" ? parsed.fieldKind : null,
        editRevision:
          typeof parsed.editRevision === "number" ? parsed.editRevision : 0,
        value: parsed.value ?? null,
        displayValue:
          typeof parsed.displayValue === "string" ? parsed.displayValue : null,
        attemptedValue: parsed.attemptedValue,
      };
    }
    if (kind === "rowTemplate") {
      if (
        typeof parsed.rowTemplateId !== "string" ||
        typeof parsed.editRevision !== "number"
      )
        return null;
      return {
        kind,
        databaseId: parsed.databaseId,
        rowTemplateId: parsed.rowTemplateId,
        editRevision: parsed.editRevision,
        name: typeof parsed.name === "string" ? parsed.name : null,
        initialCellValues: parsed.initialCellValues ?? null,
      };
    }
    if (kind === "row") {
      if (typeof parsed.rowId !== "string") return null;
      return {
        kind: "row",
        databaseId: parsed.databaseId,
        rowId: parsed.rowId,
        editRevision:
          typeof parsed.editRevision === "number" ? parsed.editRevision : 0,
        title: typeof parsed.title === "string" ? parsed.title : null,
      };
    }
    if (kind === "field") {
      if (typeof parsed.fieldId !== "string") return null;
      return {
        kind: "field",
        databaseId: parsed.databaseId,
        fieldId: parsed.fieldId,
        editRevision:
          typeof parsed.editRevision === "number" ? parsed.editRevision : 0,
        name: typeof parsed.name === "string" ? parsed.name : null,
      };
    }
    if (kind === "view") {
      if (typeof parsed.viewId !== "string") return null;
      return {
        kind: "view",
        databaseId: parsed.databaseId,
        viewId: parsed.viewId,
        editRevision:
          typeof parsed.editRevision === "number" ? parsed.editRevision : 0,
        name: typeof parsed.name === "string" ? parsed.name : null,
      };
    }
    if (kind === "database") {
      return {
        kind,
        databaseId: parsed.databaseId,
        editRevision:
          typeof parsed.editRevision === "number" ? parsed.editRevision : 0,
        title: typeof parsed.title === "string" ? parsed.title : null,
      };
    }
    if (kind === "field_order" || kind === "view_order") {
      return {
        kind,
        databaseId: parsed.databaseId,
        fields: Array.isArray(parsed.fields) ? parsed.fields : undefined,
        views: Array.isArray(parsed.views) ? parsed.views : undefined,
      };
    }
    if (kind === "bulk") {
      return {
        kind,
        databaseId: parsed.databaseId,
        conflicts: Array.isArray(parsed.conflicts)
          ? parsed.conflicts
          : undefined,
        targets: Array.isArray(parsed.targets) ? parsed.targets : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stable helper: which row ids do the given presence records currently
 * focus? The table surface uses this to render row-level indicators
 * without re-walking the records.
 */
export function focusedRowIds(
  records: ReadonlyArray<DatabasePresenceRecord>,
): string[] {
  const out: string[] = [];
  for (const record of records) {
    if (record.rowId) out.push(record.rowId);
  }
  return out;
}

/**
 * Stable helper: which field ids are currently being edited by any
 * collaborator? The table surface uses this to render cell-level
 * editing indicators next to the focused field.
 */
export function focusedFieldIds(
  records: ReadonlyArray<DatabasePresenceRecord>,
): string[] {
  const out: string[] = [];
  for (const record of records) {
    if (record.fieldId) out.push(record.fieldId);
  }
  return out;
}

/**
 * Stable helper: which user ids are currently dragging a record?
 * The Kanban surface uses this to render drag intent indicators next
 * to the affected card row.
 */
export function draggingUserIds(
  records: ReadonlyArray<DatabasePresenceRecord>,
): string[] {
  const out: string[] = [];
  for (const record of records) {
    if (record.dragging) out.push(record.userId);
  }
  return out;
}
