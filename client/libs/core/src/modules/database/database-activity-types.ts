// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stable event-type catalogue for the Database activity stream (P-DB-24).
//
// These identifiers are the contract between the server
// (`database_activity_events.event_type` column) and the client. They are
// never localized in storage; the client resolves human-readable copy
// through `com.myoxus.database.activity.*` i18n keys.

export const DatabaseActivityEventType = {
  RowCreated: "row.created",
  RowUpdated: "row.updated",
  RowDeleted: "row.deleted",
  CellChanged: "cell.changed",
  CellCleared: "cell.cleared",
  RowPositionChanged: "row.position_changed",
  RowContentDocumentAttached: "row.content_document_attached",
  RowContentDocumentDetached: "row.content_document_detached",
  RowTemplateApplied: "row.template_applied",
  RowAssignmentChanged: "row.assignment_changed",
  RowStatusChanged: "row.status_changed",
  DatabaseCreated: "database.created",
  DatabaseUpdated: "database.updated",
  DatabaseDeleted: "database.deleted",
  CsvImportCompleted: "csv.import_completed",
  JsonImportCompleted: "json.import_completed",
  CsvExportCompleted: "csv.export_completed",
  JsonExportCompleted: "json.export_completed",
} as const;

export type DatabaseActivityEventType =
  (typeof DatabaseActivityEventType)[keyof typeof DatabaseActivityEventType];

export const DATABASE_ACTIVITY_EVENT_TYPES = Object.freeze(
  Object.values(DatabaseActivityEventType),
);
