// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: focused unit tests for the conflict parser + selectors.

import { describe, expect, test } from "vitest";

import type { DatabasePresenceRecord } from "./service";
import {
  DATABASE_CONFLICT_ERROR_CODES,
  draggingUserIds,
  focusedFieldIds,
  focusedRowIds,
  parseDatabaseConflictLatestState,
} from "./types";

function makeRecord(
  overrides: Partial<DatabasePresenceRecord> = {},
): DatabasePresenceRecord {
  return {
    socketId: overrides.socketId ?? "s1",
    userId: overrides.userId ?? "u1",
    displayName: overrides.displayName ?? "Alice",
    viewId: overrides.viewId ?? null,
    rowId: overrides.rowId ?? null,
    fieldId: overrides.fieldId ?? null,
    dragging: overrides.dragging ?? false,
    lastActiveAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseDatabaseConflictLatestState", () => {
  test("returns null for falsy input", () => {
    expect(parseDatabaseConflictLatestState(null)).toBeNull();
    expect(parseDatabaseConflictLatestState(undefined)).toBeNull();
    expect(parseDatabaseConflictLatestState("")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseDatabaseConflictLatestState("not json")).toBeNull();
  });

  test("parses a cell payload", () => {
    const parsed = parseDatabaseConflictLatestState(
      JSON.stringify({
        kind: "cell",
        databaseId: "d1",
        rowId: "r1",
        fieldId: "f1",
        fieldKind: "text",
        editRevision: 3,
        value: { kind: "text", value: "hello" },
        displayValue: "hello",
      }),
    );
    expect(parsed).toEqual({
      kind: "cell",
      databaseId: "d1",
      rowId: "r1",
      fieldId: "f1",
      fieldKind: "text",
      editRevision: 3,
      value: { kind: "text", value: "hello" },
      displayValue: "hello",
      attemptedValue: undefined,
    });
  });

  test("parses a row payload", () => {
    const parsed = parseDatabaseConflictLatestState(
      JSON.stringify({
        kind: "row",
        databaseId: "d1",
        rowId: "r1",
        editRevision: 2,
        title: "Title",
      }),
    );
    expect(parsed).toEqual({
      kind: "row",
      databaseId: "d1",
      rowId: "r1",
      editRevision: 2,
      title: "Title",
    });
  });

  test("parses a field payload", () => {
    const parsed = parseDatabaseConflictLatestState(
      JSON.stringify({
        kind: "field",
        databaseId: "d1",
        fieldId: "f1",
        editRevision: 2,
        name: "Field",
      }),
    );
    expect(parsed).toEqual({
      kind: "field",
      databaseId: "d1",
      fieldId: "f1",
      editRevision: 2,
      name: "Field",
    });
  });

  test("parses a view payload", () => {
    const parsed = parseDatabaseConflictLatestState(
      JSON.stringify({
        kind: "view",
        databaseId: "d1",
        viewId: "v1",
        editRevision: 2,
        name: "View",
      }),
    );
    expect(parsed).toEqual({
      kind: "view",
      databaseId: "d1",
      viewId: "v1",
      editRevision: 2,
      name: "View",
    });
  });

  test("returns null for unknown kind", () => {
    expect(
      parseDatabaseConflictLatestState(
        JSON.stringify({ kind: "nope", databaseId: "d1", rowId: "r1" }),
      ),
    ).toBeNull();
  });

  test("returns null for cell payload missing required fields", () => {
    expect(
      parseDatabaseConflictLatestState(
        JSON.stringify({ kind: "cell", databaseId: "d1" }),
      ),
    ).toBeNull();
  });

  test("preserves typed non-string cell values", () => {
    const parsed = parseDatabaseConflictLatestState(
      JSON.stringify({
        kind: "cell",
        databaseId: "d1",
        rowId: "r1",
        fieldId: "f1",
        value: 42,
      }),
    );
    expect(parsed).toEqual({
      kind: "cell",
      databaseId: "d1",
      rowId: "r1",
      fieldId: "f1",
      fieldKind: null,
      editRevision: 0,
      value: 42,
      displayValue: null,
      attemptedValue: undefined,
    });
  });
});

describe("presence selectors", () => {
  test("focusedRowIds skips records without rowId", () => {
    const records = [
      makeRecord({ rowId: "r1" }),
      makeRecord({ rowId: null }),
      makeRecord({ rowId: "r2" }),
    ];
    expect(focusedRowIds(records)).toEqual(["r1", "r2"]);
  });

  test("focusedFieldIds returns every field id", () => {
    const records = [
      makeRecord({ fieldId: "f1" }),
      makeRecord({ fieldId: "f2" }),
    ];
    expect(focusedFieldIds(records)).toEqual(["f1", "f2"]);
  });

  test("draggingUserIds returns the user ids of dragging records", () => {
    const records = [
      makeRecord({ userId: "u1", dragging: true }),
      makeRecord({ userId: "u2", dragging: false }),
      makeRecord({ userId: "u3", dragging: true }),
    ];
    expect(draggingUserIds(records)).toEqual(["u1", "u3"]);
  });
});

describe("DATABASE_CONFLICT_ERROR_CODES", () => {
  test("matches the server's conflict error names", () => {
    expect(DATABASE_CONFLICT_ERROR_CODES).toEqual([
      "MIX_DATABASE_CONFLICT",
      "MIX_DATABASE_CELL_CONFLICT",
      "MIX_DATABASE_ROW_CONFLICT",
      "MIX_DATABASE_FIELD_CONFLICT",
      "MIX_DATABASE_VIEW_CONFLICT",
      "MIX_DATABASE_BULK_CONFLICT",
    ]);
  });
});
