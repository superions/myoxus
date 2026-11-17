// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { clearMarksOnDiscontinuousInput } from "@virgultum/content/rich-text";
import { InlineEditor } from "@virgultum/core/runtime/inline";
import { expect, test } from "vitest";
import * as Y from "yjs";

test("pending inline marks survive typed input and stop after a caret move", () => {
  const doc = new Y.Doc();
  const text = doc.getText("text");
  const editor = new InlineEditor(text);
  try {
    editor.setInlineRange({ index: 0, length: 0 });
    editor.setMarks({ code: true });
    clearMarksOnDiscontinuousInput(editor);
    editor.insertText({ index: 0, length: 0 }, "a");
    editor.setInlineRange({ index: 1, length: 0 });
    editor.insertText({ index: 1, length: 0 }, "bc");
    editor.setInlineRange({ index: 3, length: 0 });
    expect(editor.marks).toEqual({ code: true });
    editor.setInlineRange({ index: 2, length: 0 });
    expect(editor.marks).toBeNull();
  } finally {
    editor.setInlineRange(null);
    doc.destroy();
  }
});
