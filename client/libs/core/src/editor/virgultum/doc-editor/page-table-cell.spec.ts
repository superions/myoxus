// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  TableBlockSchemaExtension,
  type TableBlockModel,
} from "@virgultum/core/models";
import { Text } from "@virgultum/core/store";
import { TestWorkspace } from "@virgultum/core/store/test";
import { describe, expect, test } from "vitest";

import {
  clearCellFormatting,
  sliceYTextDelta,
  toggleCellFormat,
} from "./page-table-cell";
import { readPageContent } from "./plain-page-model";

function createTableStore() {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = [
    RootBlockSchemaExtension,
    NoteBlockSchemaExtension,
    ParagraphBlockSchemaExtension,
    TableBlockSchemaExtension,
  ];
  workspace.meta.initialize();
  const doc = workspace.createDoc("table-rich-cell-test");
  doc.load();
  const store = doc.getStore();
  const rootId = store.addBlock("myoxus:page");
  const noteId = store.addBlock("myoxus:note", {}, rootId);
  const cellText = new Text([
    { insert: "Bold", attributes: { bold: true } },
    { insert: " " },
    {
      insert: " ",
      attributes: {
        documentField: {
          id: "field-1",
          type: "input",
          definition: {
            kind: "text",
            label: "Owner",
            required: false,
          },
          value: "Alice",
        },
      },
    },
  ]);
  const protectedText = new Text("Locked cell");
  const tableId = store.addBlock(
    "myoxus:table",
    {
      rows: {
        r1: {
          rowId: "r1",
          order: "a0",
          repeat: { source: "items" },
        },
      },
      columns: {
        c1: { columnId: "c1", order: "a0" },
        c2: { columnId: "c2", order: "a1" },
      },
      cells: {
        "r1:c1": { text: cellText },
        "r1:c2": { text: protectedText, textProtection: "fixed" },
      },
    },
    noteId,
  );
  const table = store.getModelById<TableBlockModel>(tableId)!;
  return { workspace, store, table };
}

describe("PageTable rich cells, repeat rows and textProtection", () => {
  test("readPageContent accepts formatted cells, documentFields, repeat rows and protected cells", () => {
    const { workspace, store } = createTableStore();
    try {
      const content = readPageContent(store);
      expect(content).not.toBeNull();
      expect(
        content?.order.some(
          (item) => !("text" in item) && item.kind === "table",
        ),
      ).toBe(true);
    } finally {
      workspace.dispose();
    }
  });

  test("sliceYTextDelta, toggleCellFormat and clearCellFormatting support single-step undo", () => {
    const { workspace, store, table } = createTableStore();
    try {
      const yText = table.props.cells["r1:c1"].text.yText;
      const initialSlice = sliceYTextDelta(yText, 0, 4);
      expect(initialSlice).toEqual([
        { insert: "Bold", attributes: { bold: true } },
      ]);

      toggleCellFormat(table, yText, 0, 4, "italic");
      expect(sliceYTextDelta(yText, 0, 4)).toEqual([
        { insert: "Bold", attributes: { bold: true, italic: true } },
      ]);

      store.undo();
      expect(sliceYTextDelta(yText, 0, 4)).toEqual([
        { insert: "Bold", attributes: { bold: true } },
      ]);

      clearCellFormatting(table, yText, 0, 4);
      expect(sliceYTextDelta(yText, 0, 4)).toEqual([{ insert: "Bold" }]);
    } finally {
      workspace.dispose();
    }
  });
});
