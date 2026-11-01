import { literal } from "lit/static-html.js";
import { describe, expect, it, vi } from "vitest";

import { BlockSchemaExtension } from "../extension/schema.js";
import { defineBlockSchema } from "../model/block/zod.js";
// import some blocks
import { SchemaValidateError } from "../schema/error.js";
import { createAutoIncrementIdGenerator } from "../test/index.js";
import { TestWorkspace } from "../test/test-workspace.js";
import {
  DividerBlockSchemaExtension,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
} from "./test-schema.js";

function createTestOptions() {
  const idGenerator = createAutoIncrementIdGenerator();
  return { id: "test-collection", idGenerator };
}

const TestCustomNoteBlockSchema = defineBlockSchema({
  flavour: "myoxus:note-block-video",
  props: (internal) => ({
    text: internal.Text(),
  }),
  metadata: {
    version: 1,
    role: "content",
    tag: literal`myoxus-note-block-video`,
    parent: ["myoxus:note"],
  },
});

const TestCustomNoteBlockSchemaExtension = BlockSchemaExtension(
  TestCustomNoteBlockSchema,
);

const TestInvalidNoteBlockSchema = defineBlockSchema({
  flavour: "myoxus:note-invalid-block-video",
  props: (internal) => ({
    text: internal.Text(),
  }),
  metadata: {
    version: 1,
    role: "content",
    tag: literal`myoxus-invalid-note-block-video`,
    parent: ["myoxus:note"],
  },
});

const TestInvalidNoteBlockSchemaExtension = BlockSchemaExtension(
  TestInvalidNoteBlockSchema,
);

const TestRoleBlockSchema = defineBlockSchema({
  flavour: "myoxus:note-block-role-test",
  metadata: {
    version: 1,
    role: "content",
    parent: ["myoxus:note"],
    children: ["@test"],
  },
  props: (internal) => ({
    text: internal.Text(),
  }),
});

const TestRoleBlockSchemaExtension = BlockSchemaExtension(TestRoleBlockSchema);

const TestParagraphBlockSchema = defineBlockSchema({
  flavour: "myoxus:test-paragraph",
  metadata: {
    version: 1,
    role: "test",
    parent: ["@content"],
  },
});

const TestParagraphBlockSchemaExtension = BlockSchemaExtension(
  TestParagraphBlockSchema,
);

const extensions = [
  RootBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  DividerBlockSchemaExtension,
  TestCustomNoteBlockSchemaExtension,
  TestInvalidNoteBlockSchemaExtension,
  TestRoleBlockSchemaExtension,
  TestParagraphBlockSchemaExtension,
];

const defaultDocId = "doc0";
function createTestDoc(docId = defaultDocId) {
  const options = createTestOptions();
  const collection = new TestWorkspace(options);
  collection.meta.initialize();
  const doc = collection.createDoc(docId);
  doc.load();
  const store = doc.getStore({ extensions });
  return store;
}

describe("schema", () => {
  it("should be able to validate schema by role", () => {
    const consoleMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const doc = createTestDoc();
    const rootId = doc.addBlock("myoxus:page", {});
    const noteId = doc.addBlock("myoxus:note", {}, rootId);
    const paragraphId = doc.addBlock("myoxus:paragraph", {}, noteId);

    doc.addBlock("myoxus:note", {});
    expect(consoleMock.mock.calls[0]).toSatisfy((call: unknown[]) => {
      return typeof call[0] === "string";
    });
    expect(consoleMock.mock.calls[1]).toSatisfy((call: unknown[]) => {
      return call[0] instanceof SchemaValidateError;
    });

    consoleMock.mockClear();
    // add paragraph to root should throw
    doc.addBlock("myoxus:paragraph", {}, rootId);
    expect(consoleMock.mock.calls[0]).toSatisfy((call: unknown[]) => {
      return typeof call[0] === "string";
    });
    expect(consoleMock.mock.calls[1]).toSatisfy((call: unknown[]) => {
      return call[0] instanceof SchemaValidateError;
    });

    consoleMock.mockClear();
    doc.addBlock("myoxus:note", {}, rootId);
    doc.addBlock("myoxus:paragraph", {}, noteId);
    doc.addBlock("myoxus:paragraph", {}, paragraphId);
    expect(consoleMock).not.toBeCalled();
  });

  it("should glob match works", () => {
    const consoleMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const doc = createTestDoc();
    const rootId = doc.addBlock("myoxus:page", {});
    const noteId = doc.addBlock("myoxus:note", {}, rootId);

    doc.addBlock("myoxus:note-block-video", {}, noteId);
    expect(consoleMock).not.toBeCalled();

    doc.addBlock("myoxus:note-invalid-block-video", {}, noteId);
    expect(consoleMock.mock.calls[0]).toSatisfy((call: unknown[]) => {
      return typeof call[0] === "string";
    });
    expect(consoleMock.mock.calls[1]).toSatisfy((call: unknown[]) => {
      return call[0] instanceof SchemaValidateError;
    });
  });

  it("should be able to validate schema by role", () => {
    const consoleMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const doc = createTestDoc();
    const rootId = doc.addBlock("myoxus:page", {});
    const noteId = doc.addBlock("myoxus:note", {}, rootId);
    const roleId = doc.addBlock("myoxus:note-block-role-test", {}, noteId);

    doc.addBlock("myoxus:paragraph", {}, roleId);
    doc.addBlock("myoxus:paragraph", {}, roleId);

    expect(consoleMock.mock.calls[1]).toSatisfy((call: unknown[]) => {
      return call[0] instanceof SchemaValidateError;
    });

    consoleMock.mockClear();
    doc.addBlock("myoxus:test-paragraph", {}, roleId);
    doc.addBlock("myoxus:test-paragraph", {}, roleId);
    expect(consoleMock).not.toBeCalled();

    expect(doc.getBlocksByFlavour("myoxus:test-paragraph")).toHaveLength(2);
  });
});

// =====================================================================
// P-VIRG-ARCH-F-01/02 — Legacy-Flavour-Lookup in getBlocksByFlavour
//
// Negativ-Abnahme: getBlocksByFlavour("affine:paragraph") MUSS
// Bloecke finden, die als "myoxus:paragraph" persistiert wurden
// (und umgekehrt), weil die Kompatibilitaets-Expansion in
// expandFlavourVariants jetzt in der benannten
// DataFormatCompatibility-Schicht lebt.
//
// Wenn jemand `expandFlavourVariants` entfernt und auf direkten
// Set-Vergleich zurueckfaellt, brechen diese Tests rot.
// =====================================================================
describe("P-VIRG-ARCH-F-01/02 getBlocksByFlavour legacy-compat", () => {
  it("findet kanonische Bloecke bei legacy-Flavour-Anfrage", () => {
    const options = createTestOptions();
    const workspace = new TestWorkspace(options);
    workspace.meta.initialize();
    const docHandle = workspace.createDoc("test-doc-legacy-1");
    docHandle.load();
    const doc = docHandle.getStore({
      extensions: [
        RootBlockSchemaExtension,
        NoteBlockSchemaExtension,
        ParagraphBlockSchemaExtension,
        ListBlockSchemaExtension,
        DividerBlockSchemaExtension,
      ],
    });
    const rootId = doc.addBlock("myoxus:page", {});
    const noteId = doc.addBlock("myoxus:note", {}, rootId);
    doc.addBlock("myoxus:paragraph", {}, noteId);
    doc.addBlock("myoxus:paragraph", {}, noteId);

    // Anfrage mit legacy-Flavour MUSS dieselben Bloecke finden.
    const byLegacy = doc.getBlocksByFlavour("affine:paragraph");
    const byCanonical = doc.getBlocksByFlavour("myoxus:paragraph");
    expect(byLegacy).toHaveLength(2);
    expect(byCanonical).toHaveLength(2);
    expect(byLegacy.map((b) => b.id).sort()).toEqual(
      byCanonical.map((b) => b.id).sort(),
    );
  });

  it("findet legacy-persistierte Bloecke bei kanonischer Anfrage (gemaess Schema)", () => {
    // Persistenz-Weg: Doc speichert das, was addBlock aufnimmt.
    // Wenn das Schema in `getBlocksByFlavour` Alias-aware ist,
    // MUSS die Anfrage mit dem jeweils anderen Namen gleich
    // antworten — egal welcher Name beim Speichern benutzt wurde.
    const options = createTestOptions();
    const workspace = new TestWorkspace(options);
    workspace.meta.initialize();
    const docHandle = workspace.createDoc("test-doc-legacy-2");
    docHandle.load();
    const doc = docHandle.getStore({
      extensions: [
        RootBlockSchemaExtension,
        NoteBlockSchemaExtension,
        ParagraphBlockSchemaExtension,
        ListBlockSchemaExtension,
        DividerBlockSchemaExtension,
      ],
    });
    const rootId = doc.addBlock("myoxus:page", {});
    const noteId = doc.addBlock("myoxus:note", {}, rootId);
    doc.addBlock("myoxus:paragraph", {}, noteId);

    // Aliase Set hat {myoxus:paragraph, affine:paragraph} =
    // identische Treffermenge.
    const setA = new Set(
      doc.getBlocksByFlavour("myoxus:paragraph").map((b) => b.id),
    );
    const setB = new Set(
      doc.getBlocksByFlavour("affine:paragraph").map((b) => b.id),
    );
    expect(setA).toEqual(setB);
  });
});
