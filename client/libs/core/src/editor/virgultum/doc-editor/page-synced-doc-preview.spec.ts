// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { Text } from "@virgultum/core/store";
import { TestWorkspace } from "@virgultum/core/store/test";
import {
  CalloutBlockSchemaExtension,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
} from "@virgultum/core/models";
import { projectSyncedDocContent } from "./page-synced-doc-preview";

function createTestDoc() {
  const workspace = new TestWorkspace({ id: "page-synced-doc-preview-spec" });
  workspace.meta.initialize();
  const doc = workspace.createDoc("target-doc");
  doc.load();
  const store = doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      ListBlockSchemaExtension,
      CalloutBlockSchemaExtension,
    ],
  });
  const rootId = store.addBlock("myoxus:page", {
    title: new Text("Runbook"),
  });
  const noteId = store.addBlock("myoxus:note", {}, rootId);
  return { store, noteId };
}

describe("projectSyncedDocContent (SPE-05b / OBS-14)", () => {
  it("projects a heading section up to the next same-level heading and updates live", () => {
    const { store, noteId } = createTestDoc();
    store.addBlock(
      "myoxus:paragraph",
      { type: "h2", text: new Text("Intro") },
      noteId,
    );
    store.addBlock(
      "myoxus:paragraph",
      { type: "text", text: new Text("Intro text") },
      noteId,
    );
    const opsHeadingId = store.addBlock(
      "myoxus:paragraph",
      { type: "h2", text: new Text("Operations") },
      noteId,
    );
    store.addBlock(
      "myoxus:paragraph",
      { type: "text", text: new Text("Step 1") },
      noteId,
    );
    store.addBlock(
      "myoxus:paragraph",
      { type: "h3", text: new Text("Sub-step") },
      noteId,
    );
    store.addBlock(
      "myoxus:list",
      { type: "bulleted", text: new Text("Bullet A") },
      noteId,
    );
    store.addBlock(
      "myoxus:paragraph",
      { type: "h2", text: new Text("Appendix") },
      noteId,
    );
    store.addBlock(
      "myoxus:paragraph",
      { type: "text", text: new Text("Appendix secret") },
      noteId,
    );

    const res = projectSyncedDocContent(
      store,
      { blockIds: [opsHeadingId], blockSelection: "section" },
      "page",
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok" || !res.content)
      throw new Error("Expected content");

    const texts = res.content.lines
      .slice(1)
      .map((line) => line.text.toString());
    expect(texts).toEqual(["Operations", "Step 1", "Sub-step", "Bullet A"]);

    // Live source edit inside the section reflects immediately on re-projection
    const opsHeading = store.getModelById(opsHeadingId)!;
    opsHeading.text!.insert(" Live", opsHeading.text!.length);
    const updated = projectSyncedDocContent(
      store,
      { blockIds: [opsHeadingId], blockSelection: "section" },
      "page",
    );
    expect(updated.status).toBe("ok");
    if (updated.status !== "ok" || !updated.content)
      throw new Error("Expected updated content");
    expect(updated.content.lines[1].text.toString()).toBe("Operations Live");

    // Deleting the target heading fails closed instead of widening
    store.deleteBlock(opsHeading);
    const deleted = projectSyncedDocContent(
      store,
      { blockIds: [opsHeadingId], blockSelection: "section" },
      "page",
    );
    expect(deleted.status).toBe("error");
  });

  it("projects a block subtree and promotes nested selections without leaking ancestors", () => {
    const { store, noteId } = createTestDoc();
    const outerId = store.addBlock(
      "myoxus:paragraph",
      { type: "text", text: new Text("Unselected ancestor secret") },
      noteId,
    );
    const targetId = store.addBlock(
      "myoxus:paragraph",
      { type: "text", text: new Text("Selected parent") },
      outerId,
    );
    store.addBlock(
      "myoxus:list",
      { type: "bulleted", text: new Text("Selected child") },
      targetId,
    );
    store.addBlock(
      "myoxus:paragraph",
      { type: "text", text: new Text("Sibling outside") },
      outerId,
    );

    const res = projectSyncedDocContent(
      store,
      { blockIds: [targetId], blockSelection: "subtree" },
      "page",
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok" || !res.content)
      throw new Error("Expected content");

    const texts = res.content.lines
      .slice(1)
      .map((line) => line.text.toString());
    expect(texts).toEqual(["Selected parent", "Selected child"]);
    expect(res.content.lines[1].depth).toBe(0);
    expect(res.content.lines[2].depth).toBe(1);
  });

  it("fails closed on non-heading section, ambiguous blockIds, or edgeless mode", () => {
    const { store, noteId } = createTestDoc();
    const p1 = store.addBlock(
      "myoxus:paragraph",
      { type: "text", text: new Text("Plain paragraph") },
      noteId,
    );
    const p2 = store.addBlock(
      "myoxus:paragraph",
      { type: "text", text: new Text("Second paragraph") },
      noteId,
    );

    expect(
      projectSyncedDocContent(
        store,
        { blockIds: [p1], blockSelection: "section" },
        "page",
      ).status,
    ).toBe("error");

    expect(
      projectSyncedDocContent(
        store,
        { blockIds: [p1, p2], blockSelection: "subtree" },
        "page",
      ).status,
    ).toBe("error");

    expect(
      projectSyncedDocContent(
        store,
        { blockIds: [p1], blockSelection: "subtree" },
        "edgeless",
      ).status,
    ).toBe("error");
  });
});
