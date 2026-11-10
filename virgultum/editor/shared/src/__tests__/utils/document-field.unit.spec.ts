// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  DocumentFieldSchema,
  cloneDocumentField,
  initializeDocumentField,
  cloneTextWithDocumentFieldIdentities,
  remapDocumentFieldIdentities,
  freezeDocumentField,
  reactivateDocumentField,
  validateDocumentFieldRun,
  type MyoxusTextAttributes,
} from "../../types";
import { Text, type DeltaInsert } from "@virgultum/store";
import fixtures from "../../../../../../build/fixtures/contracts/document-fields.json";

describe("native document field contract", () => {
  test("admits the shared wire shapes without rewriting literal data", () => {
    for (const value of fixtures.valid)
      expect(DocumentFieldSchema.parse(value)).toEqual(value);
    for (const value of fixtures.invalid)
      expect(DocumentFieldSchema.safeParse(value).success).toBe(false);
  });

  test("retains independent adjacent native embeds and restores frozen canonical answers", () => {
    const descriptor = DocumentFieldSchema.parse(fixtures.valid[0]);
    const first: DeltaInsert<MyoxusTextAttributes> = {
      insert: " ",
      attributes: {
        documentField: DocumentFieldSchema.parse({
          ...descriptor,
          value: "Filled {{literal}}",
        }),
        bold: true,
      },
    };
    const second = {
      ...first,
      attributes: {
        ...first.attributes,
        documentField: cloneDocumentField(descriptor, "text-b"),
      },
    };
    const frozen = freezeDocumentField(first, "Nicht ausgefüllt");
    expect(reactivateDocumentField(frozen)).toEqual(first);
    expect(() => freezeDocumentField(first, "")).toThrow();
    expect(first.attributes?.documentFieldCaptured).toBeUndefined();
    const doc = new Y.Doc();
    const copy = new Y.Doc();
    try {
      const text = doc.getText("text");
      text.applyDelta([
        { insert: "{{ordinary}} é😀" },
        first,
        second,
        {
          ...frozen,
          attributes: {
            ...frozen.attributes,
            documentField: cloneDocumentField(
              frozen.attributes!.documentField!,
              "text-c",
            ),
          },
        },
      ]);
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      const delta = copy
        .getText("text")
        .toDelta() as DeltaInsert<MyoxusTextAttributes>[];
      delta.forEach(validateDocumentFieldRun);
      expect(delta.map((run) => run.attributes?.documentField?.id)).toEqual([
        undefined,
        "text-a",
        "text-b",
        "text-c",
      ]);
      expect(delta[0].insert).toBe("{{ordinary}} é😀");
      expect(delta[3].insert).toBe("Nicht ausgefüllt");
      expect(delta[3].attributes?.documentField).toEqual({
        ...first.attributes?.documentField,
        id: "text-c",
      });
      expect(delta[3].attributes?.bold).toBe(true);
      expect(initializeDocumentField(first.attributes!.documentField!)).toEqual(
        {
          ...descriptor,
          value: "  {{literal}}  ",
        },
      );
      const source = new Text(text);
      let nextId = 0;
      const cloned = cloneTextWithDocumentFieldIdentities(
        source,
        () => `copy-${++nextId}`,
      );
      const copies = copy.getMap<Y.Text>("copies");
      const undo = new Y.UndoManager(copies);
      copies.set("text", cloned.yText);
      const clonedDelta =
        cloned.toDelta() as DeltaInsert<MyoxusTextAttributes>[];
      expect(
        clonedDelta.map((run) => run.attributes?.documentField?.id),
      ).toEqual([undefined, "copy-1", "copy-2", "copy-3"]);
      expect(clonedDelta[1].attributes?.documentField).toMatchObject({
        value: "Filled {{literal}}",
      });
      expect(clonedDelta[3].attributes?.documentFieldCaptured).toBeUndefined();
      expect(clonedDelta[3].insert).toBe(" ");
      expect(clonedDelta[3].attributes?.documentField).toMatchObject({
        value: "Filled {{literal}}",
      });
      undo.undo();
      expect(copies.has("text")).toBe(false);
      undo.redo();
      expect(copies.get("text")!.toDelta()).toEqual(clonedDelta);
      undo.destroy();
      expect(source.toDelta()).toEqual(delta);
      const snapshot = {
        text: {
          "$virgultum:internal:text$": true,
          delta: structuredClone(delta),
        },
        opaque: {
          "$virgultum:internal:native$": true,
          value: {
            "$virgultum:internal:text$": true,
            delta: structuredClone(delta),
          },
        },
      };
      remapDocumentFieldIdentities(snapshot, () => `paste-${++nextId}`);
      expect(snapshot.text.delta[1].attributes?.documentField?.id).toBe(
        "paste-4",
      );
      expect(snapshot.text.delta[1].attributes?.documentField).toMatchObject({
        value: "Filled {{literal}}",
      });
      expect(
        snapshot.text.delta[3].attributes?.documentFieldCaptured,
      ).toBeUndefined();
      expect(snapshot.text.delta[3].insert).toBe(" ");
      expect(snapshot.opaque.value.delta).toEqual(delta);
      const split = {
        text: {
          "$virgultum:internal:text$": true,
          delta: [
            { ...structuredClone(frozen), insert: "Nicht " },
            {
              ...structuredClone(frozen),
              insert: "ausgefüllt",
              attributes: {
                ...structuredClone(frozen.attributes),
                italic: true,
              },
            },
            { insert: " literal" },
          ],
        },
      };
      remapDocumentFieldIdentities(split, () => "pasted-field");
      expect(split.text.delta).toHaveLength(2);
      expect(split.text.delta[0]).toMatchObject({
        insert: " ",
        attributes: {
          documentField: { id: "pasted-field", value: "Filled {{literal}}" },
          bold: true,
        },
      });
      expect(
        split.text.delta[0].attributes?.documentFieldCaptured,
      ).toBeUndefined();
      expect(split.text.delta[1].insert).toBe(" literal");
      expect(() =>
        validateDocumentFieldRun({ ...first, insert: "cached display" }),
      ).toThrow();
      expect(() =>
        validateDocumentFieldRun({
          ...first,
          attributes: {
            ...first.attributes,
            reference: { type: "LinkedPage", pageId: "other" },
          },
        }),
      ).toThrow();
    } finally {
      doc.destroy();
      copy.destroy();
    }
  });
});
