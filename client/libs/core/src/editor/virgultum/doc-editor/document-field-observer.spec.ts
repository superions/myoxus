// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import {
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  TableBlockSchemaExtension,
  type TableBlockModel,
} from "@virgultum/model";
import { Boxed, Text } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import type {
  DocumentField,
  MyoxusTextAttributes,
} from "@virgultum/editor/shared/types";
import * as Y from "yjs";
import { afterEach, expect, test, vi } from "vitest";

import { observeDocumentFields } from "./document-field-observer";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});
const tick = () => Promise.resolve();
const metadata = (
  id: string,
  key: Extract<DocumentField, { type: "metadata" }>["key"] = "title",
): Extract<DocumentField, { type: "metadata" }> => ({
  type: "metadata",
  id,
  key,
  format: "text",
});
const input: DocumentField = {
  type: "input",
  id: "answer",
  definition: { kind: "text", label: "Answer", required: false },
  value: null,
};
function setup() {
  const workspace = new TestWorkspace({ id: "field-observer" });
  workspace.meta.initialize();
  const leaf = workspace.createDoc("document");
  leaf.load();
  const store = leaf.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      TableBlockSchemaExtension,
    ],
  });
  const root = store.addBlock("myoxus:page", {});
  const note = store.addBlock("myoxus:note", {}, root);
  cleanups.push(() => {
    leaf.dispose();
    workspace.dispose();
  });
  const paragraph = (text: Text) => {
    const id = store.addBlock("myoxus:paragraph", { text }, note);
    return store.getModelById(id)!;
  };
  const publish = vi.fn();
  const invalid = vi.fn();
  const observe = () =>
    cleanups.push(observeDocumentFields(store, publish, invalid));
  return { store, note, paragraph, publish, invalid, observe };
}

test("field-free/input typing and layout changes do not export or read other native owners", async () => {
  const { store, note, paragraph, publish, invalid, observe } = setup();
  const ordinary = paragraph(new Text("ordinary"));
  const answer = paragraph(
    new Text<MyoxusTextAttributes>([
      { insert: " ", attributes: { documentField: input } },
    ]),
  );
  const untouched = paragraph(new Text("untouched"));
  const exportDocument = vi.spyOn(store, "getTransformer");
  observe();
  await tick();
  const readUntouched = vi.spyOn(untouched.text!.yText, "toDelta");
  publish.mockClear();
  ordinary.text!.insert(" typing", ordinary.text!.length);
  answer.text!.insert(" notes", answer.text!.length, {});
  ordinary.text!.format(0, 1, { bold: true });
  store.updateBlock(store.getModelById(note)!, { xywh: "[0,0,900,700]" });
  await tick();
  expect(readUntouched).not.toHaveBeenCalled();
  expect(exportDocument).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(invalid).not.toHaveBeenCalled();
});

test("metadata descriptors follow native text, shared table replacement, remote edits and subtree deletion", async () => {
  const { store, note, paragraph, publish, invalid, observe } = setup();
  const block = paragraph(new Text("Text "));
  const untouched = paragraph(new Text("Not involved"));
  observe();
  await tick();
  const unrelated = vi.spyOn(untouched.text!.yText, "toDelta");
  block.text!.insert(" ", block.text!.length, {
    documentField: metadata("first"),
  });
  await tick();
  expect(publish).toHaveBeenLastCalledWith([metadata("first")]);
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(store.spaceDoc));
  const remoteText = (
    remote.getMap("blocks").get(block.id) as Y.Map<unknown>
  ).get("prop:text") as Y.Text;
  remoteText.format(remoteText.length - 1, 1, {
    documentField: metadata("first", "status"),
  });
  Y.applyUpdate(store.spaceDoc, Y.encodeStateAsUpdate(remote));
  remote.destroy();
  await tick();
  expect(publish).toHaveBeenLastCalledWith([metadata("first", "status")]);
  const tableId = store.addBlock(
    "myoxus:table",
    {
      rows: { r: { rowId: "r", order: "a0" } },
      columns: { c: { columnId: "c", order: "a0" } },
      cells: {
        "r:c": {
          text: new Text<MyoxusTextAttributes>([
            { insert: " ", attributes: { documentField: metadata("cell") } },
          ]),
        },
      },
    },
    note,
  );
  await tick();
  expect(publish).toHaveBeenLastCalledWith([
    metadata("cell"),
    metadata("first", "status"),
  ]);
  const table = store.getModelById(tableId) as TableBlockModel;
  table.props.cells["r:c"]!.text = new Text("No field");
  await tick();
  expect(publish).toHaveBeenLastCalledWith([metadata("first", "status")]);
  block.text!.delete(block.text!.length - 1, 1);
  await tick();
  expect(publish).toHaveBeenLastCalledWith([]);
  const child = paragraph(
    new Text<MyoxusTextAttributes>([
      { insert: " ", attributes: { documentField: metadata("removed") } },
    ]),
  );
  await tick();
  expect(publish).toHaveBeenLastCalledWith([metadata("removed")]);
  store.deleteBlock(child);
  await tick();
  expect(publish).toHaveBeenLastCalledWith([]);
  expect(unrelated).not.toHaveBeenCalled();
  expect(invalid).not.toHaveBeenCalled();
});

test("captured/private text stays opaque; malformed/duplicate live fields fail closed and dispose stops observation", async () => {
  const { store, paragraph, publish, invalid, observe } = setup();
  const block = paragraph(
    new Text<MyoxusTextAttributes>([
      {
        insert: "Archived title",
        attributes: {
          documentField: metadata("captured"),
          documentFieldCaptured: true,
        },
      },
    ]),
  );
  // Native private values cannot become live metadata discovery inputs.
  const privateText = new Y.Text();
  privateText.applyDelta([
    { insert: " ", attributes: { documentField: metadata("private") } },
  ]);
  block.yBlock.set("prop:private", new Boxed(privateText).yMap);
  const before = Y.encodeStateAsUpdate(store.spaceDoc);
  observe();
  await tick();
  expect(publish).toHaveBeenLastCalledWith([]);
  expect(Y.encodeStateAsUpdate(store.spaceDoc)).toEqual(before);
  const one = paragraph(
    new Text<MyoxusTextAttributes>([
      { insert: " ", attributes: { documentField: metadata("same") } },
    ]),
  );
  await tick();
  const two = paragraph(
    new Text<MyoxusTextAttributes>([
      { insert: " ", attributes: { documentField: metadata("same") } },
    ]),
  );
  await tick();
  expect(invalid).toHaveBeenCalledTimes(1);
  store.deleteBlock(two);
  await tick();
  expect(publish).toHaveBeenLastCalledWith([metadata("same")]);
  one.text!.yText.format(0, 1, {
    documentField: { type: "metadata", id: "broken" },
  });
  await tick();
  expect(invalid).toHaveBeenCalledTimes(2);
  const dispose = cleanups.pop()!;
  dispose();
  const calls = publish.mock.calls.length;
  one.text!.yText.format(0, 1, { documentField: metadata("restored") });
  await tick();
  expect(publish).toHaveBeenCalledTimes(calls);
});
