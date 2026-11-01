// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {
  CodeBlockSchemaExtension,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  TableBlockSchemaExtension,
  type TableBlockModel,
  type ListBlockModel,
  normalizeTableColumnTextAlign,
  TextAlign,
} from "@virgultum/model";
import { transformModel } from "@virgultum/shared/utils";
import { Text } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { afterEach, expect, test } from "vitest";

import { TableDataManager } from "@virgultum/block-table";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function setup() {
  const workspace = new TestWorkspace({ id: "repeat-native" });
  workspace.meta.initialize();
  const leaf = workspace.createDoc("source");
  leaf.load();
  const store = leaf.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      ListBlockSchemaExtension,
      TableBlockSchemaExtension,
      CodeBlockSchemaExtension,
    ],
  });
  const root = store.addBlock("myoxus:page", {});
  const note = store.addBlock("myoxus:note", {}, root);
  cleanups.push(() => {
    leaf.dispose();
    workspace.dispose();
  });
  return { store, note };
}
const repeat = { source: "workspace.members", alias: "member" };

test("row binding removal and undo/redo preserve native row, cell text and column identity", () => {
  const { store, note } = setup();
  const id = store.addBlock(
    "myoxus:table",
    {
      rows: { r: { rowId: "r", order: "a0" } },
      columns: { c: { columnId: "c", order: "a0" } },
      cells: { "r:c": { text: new Text("{{member.name}}") } },
    },
    note,
  );
  const table = store.getModelById(id) as TableBlockModel;
  const manager = new TableDataManager(table);
  store.resetHistory();
  manager.setRowRepeat("r", repeat);
  expect(table.props.rows.r!.repeat).toEqual(repeat);
  manager.setRowRepeat("r", undefined);
  expect(table.props.rows.r!.repeat).toBeUndefined();
  store.undo();
  expect(table.props.rows.r!.repeat).toEqual(repeat);
  store.redo();
  expect(table.props.rows.r!.repeat).toBeUndefined();
  expect(table.props.cells["r:c"]!.text.toString()).toBe("{{member.name}}");
  expect(Object.keys(table.props.rows)).toEqual(["r"]);
  expect(Object.keys(table.props.columns)).toEqual(["c"]);
  expect(Object.keys(table.props.cells)).toEqual(["r:c"]);
  store.readonly = true;
  manager.setRowRepeat("r", repeat);
  expect(table.props.rows.r!.repeat).toBeUndefined();
});

test("explicit table headers preserve positional edits and reject repeat conflicts", () => {
  const { store, note } = setup();
  const id = store.addBlock(
    "myoxus:table",
    {
      headerRows: 1,
      rows: {
        h: { rowId: "h", order: "a0" },
        b: { rowId: "b", order: "a1" },
        r: { rowId: "r", order: "a2", repeat },
      },
      columns: { c: { columnId: "c", order: "a0" } },
      cells: {
        "h:c": { text: new Text("Header") },
        "b:c": { text: new Text("Body") },
        "r:c": { text: new Text("{{member.name}}") },
      },
    },
    note,
  );
  const table = store.getModelById(id) as TableBlockModel;
  const manager = new TableDataManager(table);

  expect(manager.setRowRepeat("h", repeat)).toBe(false);
  expect(manager.setHeaderRows(3)).toBe(false);
  expect(manager.moveRow(2, undefined)).toBe(false);
  expect(manager.rows$.value.map((row) => row.rowId)).toEqual(["h", "b", "r"]);

  store.resetHistory();
  const insertedHeader = manager.addRow();
  expect(manager.headerRows$.value).toBe(2);
  expect(manager.rows$.value[0]?.rowId).toBe(insertedHeader);
  store.undo();
  expect(manager.headerRows$.value).toBe(1);
  expect(manager.rows$.value.map((row) => row.rowId)).toEqual(["h", "b", "r"]);
  store.redo();
  expect(manager.headerRows$.value).toBe(2);
  expect(manager.rows$.value[0]?.rowId).toBe(insertedHeader);

  manager.addRow(1);
  expect(manager.headerRows$.value).toBe(2);
  manager.deleteRow(insertedHeader);
  expect(manager.headerRows$.value).toBe(1);
});

test("column alignment is one undoable flat property preserved by column operations", () => {
  expect(normalizeTableColumnTextAlign("justify")).toBeUndefined();

  const { store, note } = setup();
  const id = store.addBlock(
    "myoxus:table",
    {
      rows: { r: { rowId: "r", order: "a0" } },
      columns: { c: { columnId: "c", order: "a0" } },
      cells: { "r:c": { text: new Text("**marked**") } },
    },
    note,
  );
  const table = store.getModelById(id) as TableBlockModel;
  const manager = new TableDataManager(table);

  store.resetHistory();
  manager.setColumnTextAlign("c", TextAlign.Right);
  expect(table.props.columns.c?.textAlign).toBe(TextAlign.Right);
  store.undo();
  expect(table.props.columns.c?.textAlign).toBeUndefined();
  store.redo();
  expect(table.props.columns.c?.textAlign).toBe(TextAlign.Right);

  const duplicateId = manager.duplicateColumn(0)!;
  expect(table.props.columns[duplicateId]?.textAlign).toBe(TextAlign.Right);
  expect(table.props.cells[`r:${duplicateId}`]?.text.toString()).toBe(
    "**marked**",
  );
  manager.moveColumn(1, undefined);
  expect(manager.columns$.value[0]?.columnId).toBe(duplicateId);
  const insertedId = manager.addColumn(manager.columns$.value.length - 1);
  expect(table.props.columns[insertedId]?.textAlign).toBeUndefined();

  manager.setColumnTextAlign("c", undefined);
  expect(table.props.columns.c).not.toHaveProperty("textAlign");
  store.readonly = true;
  manager.setColumnTextAlign("c", TextAlign.Center);
  expect(table.props.columns.c).not.toHaveProperty("textAlign");
});

test("supported native conversion preserves repeat while unsupported conversion drops it undoably", () => {
  const { store, note } = setup();
  const id = store.addBlock(
    "myoxus:paragraph",
    {
      repeat,
      text: new Text([
        { insert: "{{member.name}}", attributes: { bold: true } },
      ]),
    },
    note,
  );
  const listId = transformModel(store.getModelById(id)!, "myoxus:list", {
    type: "todo",
  })!;
  expect((store.getModelById(listId) as ListBlockModel).props.repeat).toEqual(
    repeat,
  );
  store.resetHistory();
  const codeId = transformModel(store.getModelById(listId)!, "myoxus:code")!;
  expect(store.getModelById(codeId)!.props).not.toHaveProperty("repeat");
  expect(store.getModelById(codeId)!.text!.toString()).toBe("{{member.name}}");
  store.undo();
  expect((store.getModelById(listId) as ListBlockModel).props.repeat).toEqual(
    repeat,
  );
  expect(store.getModelById(listId)!.text!.toDelta()).toEqual([
    { insert: "{{member.name}}", attributes: { bold: true } },
  ]);
});
