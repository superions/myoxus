// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import { TextSelection } from "@virgultum/editor/std";
import type { BlockStdScope } from "@virgultum/editor/std";
import type { BlockModel } from "@virgultum/editor/store";
import { snapshotTaskCaptureSelection } from "./task-capture-selection";

describe("Task capture selection", () => {
  test("captures endpoint ranges and complete intervening text without copying outside the selection", () => {
    const selection = new TextSelection({
      from: { blockId: "first", index: 7, length: 5 },
      to: { blockId: "last", index: 0, length: 4 },
    });
    const std = {
      store: { doc: { id: "source" }, getParent: () => null },
      getOptional: () => undefined,
      selection: { find: () => selection },
    } as unknown as BlockStdScope;
    const models = [
      ["first", "Before first"],
      ["middle", "middle"],
      ["last", "last after"],
    ].map(([id, text]) => ({
      id,
      flavour: "myoxus:paragraph",
      text: { toString: () => text },
    })) as unknown as BlockModel[];
    expect(snapshotTaskCaptureSelection(std, models)?.excerpt).toBe(
      "first\nmiddle\nlast",
    );
    expect(snapshotTaskCaptureSelection(std, models.slice(1))).toBeNull();
    expect(
      snapshotTaskCaptureSelection(std, [
        ...models,
        { ...models[0], id: "unrelated" },
      ] as BlockModel[]),
    ).toBeNull();
    selection.from.index = 100;
    expect(snapshotTaskCaptureSelection(std, models)).toBeNull();
  });
});

test("Edgeless capture freezes native text endpoints and containing Note, excluding shapes and other Notes", () => {
  const note = {
    id: "sticky",
    flavour: "myoxus:note",
    props: { xywh: "[748,39,498,89]" },
  };
  const selection = new TextSelection({
    from: { blockId: "sticky-text", index: 7, length: 6 },
    to: null,
  });
  const std = {
    store: { doc: { id: "source" }, getParent: () => note },
    selection: { find: () => selection },
    getOptional: () => ({ getEditorMode: () => "edgeless" }),
  } as unknown as BlockStdScope;
  const model = {
    id: "sticky-text",
    flavour: "myoxus:paragraph",
    text: { toString: () => "Before chosen after", length: 19 },
  } as unknown as BlockModel;
  const snapshot = snapshotTaskCaptureSelection(std, [model])!;
  expect(snapshot.excerpt).toBe("chosen");
  const anchor = JSON.parse(snapshot.selectionAnchor!);
  expect(TextSelection.fromJSON(anchor).toJSON()).toEqual(selection.toJSON());
  expect(anchor.captureMode).toBe("edgeless");
  expect(anchor.noteId).toBe("sticky");
  selection.from.blockId = "later-selection";
  expect(JSON.parse(snapshot.selectionAnchor!).from.blockId).toBe(
    "sticky-text",
  );
  expect(note.props.xywh).toBe("[748,39,498,89]");
  expect(
    snapshotTaskCaptureSelection(std, [
      { ...model, flavour: "myoxus:shape" },
    ] as BlockModel[]),
  ).toBeNull();
  const detached = {
    ...std,
    store: { ...std.store, getParent: () => null },
  } as unknown as BlockStdScope;
  expect(snapshotTaskCaptureSelection(detached, [model])).toBeNull();
});
