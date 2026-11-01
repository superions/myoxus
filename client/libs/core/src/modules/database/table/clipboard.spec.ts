// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment node */

import { DatabaseFieldKind } from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import { createCellValueInput } from "../model";
import type { DatabaseField } from "../types";
import {
  databaseTableParseClipboardValue,
  isDatabaseTableCellEditable,
} from "./clipboard";
import { isDatabaseTableFieldSupported } from "./labels";

function field(
  fieldType: DatabaseFieldKind,
  config: Record<string, unknown> = {},
): DatabaseField {
  return {
    id: `field-${fieldType}`,
    databaseId: "database-1",
    name: fieldType,
    fieldType,
    config: {
      checkbox: null,
      createdBy: null,
      createdTime: null,
      currency: null,
      date: null,
      dateTime: null,
      duration: null,
      email: null,
      files: null,
      formula: null,
      kind: fieldType,
      multiSelect: null,
      number: null,
      percent: null,
      phone: null,
      relation: null,
      rollup: null,
      select: null,
      status: null,
      text: null,
      title: null,
      uniqueId: null,
      updatedBy: null,
      updatedTime: null,
      url: null,
      user: null,
      users: null,
      ...config,
    },
    position: 0,
    required: false,
    editRevision: 1,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
  } as unknown as DatabaseField;
}

const OPTIONS = [
  { id: "option-todo", name: "Todo", colorRole: null, position: 0 },
  { id: "option-done", name: "Done", colorRole: null, position: 1 },
];

describe("Database Table clipboard field matrix", () => {
  test.each([
    [DatabaseFieldKind.Checkbox, "yes", true],
    [DatabaseFieldKind.Date, "2026-07-10", "2026-07-10"],
    [
      DatabaseFieldKind.DateTime,
      "2026-07-10T09:30:00Z",
      "2026-07-10T09:30:00Z",
    ],
    [DatabaseFieldKind.Files, "blob-a", "blob-a"],
    [DatabaseFieldKind.Number, "12,5", 12.5],
    [DatabaseFieldKind.Percent, "42%", 42],
    [DatabaseFieldKind.Duration, "2 h", { minutes: 120 }],
    [DatabaseFieldKind.Relation, "row-1, row-2", ["row-1", "row-2"]],
    [DatabaseFieldKind.Title, "  Roadmap  ", "  Roadmap  "],
    [DatabaseFieldKind.Text, "  Notes  ", "  Notes  "],
    [
      DatabaseFieldKind.Url,
      " https://myoxus.example ",
      " https://myoxus.example ",
    ],
    [DatabaseFieldKind.Email, " team@myoxus.example ", " team@myoxus.example "],
    [DatabaseFieldKind.Phone, " +49 123 ", " +49 123 "],
    [DatabaseFieldKind.User, " user-1 ", " user-1 "],
    [DatabaseFieldKind.Users, "user-1, user-2", ["user-1", "user-2"]],
    [DatabaseFieldKind.Tags, "tag-1, tag-2", ["tag-1", "tag-2"]],
  ] as const)("parses editable %s values", (kind, input, expected) => {
    const target = field(kind);
    expect(isDatabaseTableFieldSupported(kind)).toBe(true);
    expect(isDatabaseTableCellEditable(target)).toBe(true);
    expect(databaseTableParseClipboardValue(target, input)).toEqual(expected);
  });

  test.each([
    [
      DatabaseFieldKind.MultiSelect,
      { multiSelect: { options: OPTIONS } },
      ["option-todo", "option-done"],
    ],
    [DatabaseFieldKind.Select, { select: { options: OPTIONS } }, "option-done"],
    [DatabaseFieldKind.Status, { status: { options: OPTIONS } }, "option-todo"],
  ] as const)("resolves option labels for %s", (kind, config, expected) => {
    const target = field(kind, config);
    const input =
      kind === DatabaseFieldKind.MultiSelect
        ? "Todo, Done"
        : kind === DatabaseFieldKind.Select
          ? "Done"
          : "Todo";
    expect(isDatabaseTableCellEditable(target)).toBe(true);
    expect(databaseTableParseClipboardValue(target, input)).toEqual(expected);
  });

  test("normalizes currency codes and amounts", () => {
    const target = field(DatabaseFieldKind.Currency, {
      currency: { defaultCurrency: "EUR" },
    });
    expect(databaseTableParseClipboardValue(target, "USD 12.5")).toEqual({
      amount: 12.5,
      currencyCode: "USD",
    });
  });

  test("converts pasted RichText into the canonical structured GraphQL input", () => {
    const target = field(DatabaseFieldKind.RichText);
    const document = databaseTableParseClipboardValue(
      target,
      "  First line  \r\n\r\nSecond line",
    );

    expect(isDatabaseTableFieldSupported(DatabaseFieldKind.RichText)).toBe(
      true,
    );
    expect(isDatabaseTableCellEditable(target)).toBe(true);
    expect(createCellValueInput(target, document)).toEqual({
      richText: {
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "  First line  " }],
            },
            { type: "paragraph" },
            {
              type: "paragraph",
              content: [{ type: "text", text: "Second line" }],
            },
          ],
        },
      },
    });
  });

  test.each([
    DatabaseFieldKind.CreatedBy,
    DatabaseFieldKind.CreatedTime,
    DatabaseFieldKind.Formula,
    DatabaseFieldKind.Rollup,
    DatabaseFieldKind.UniqueId,
    DatabaseFieldKind.UpdatedBy,
    DatabaseFieldKind.UpdatedTime,
  ])("rejects read-only %s fields", (kind) => {
    const target = field(kind);
    expect(isDatabaseTableFieldSupported(kind)).toBe(true);
    expect(isDatabaseTableCellEditable(target)).toBe(false);
    expect(() => databaseTableParseClipboardValue(target, "value")).toThrow();
  });

  test("renders DocumentLink but rejects unchecked clipboard document ids", () => {
    const target = field(DatabaseFieldKind.DocumentLink);
    expect(isDatabaseTableFieldSupported(DatabaseFieldKind.DocumentLink)).toBe(
      true,
    );
    expect(isDatabaseTableCellEditable(target)).toBe(false);
    expect(() => databaseTableParseClipboardValue(target, "value")).toThrow(
      `Unsupported database clipboard field type: ${DatabaseFieldKind.DocumentLink}`,
    );
  });
});
