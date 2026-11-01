// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
/** @vitest-environment happy-dom */

import { afterEach, expect, test, vi } from "vitest";
import { copyTextToClipboard } from "./index";

const originalCommand = Object.getOwnPropertyDescriptor(
  document,
  "execCommand",
);
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCommand)
    Object.defineProperty(document, "execCommand", originalCommand);
  else delete (document as Partial<Document>).execCommand;
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

test.each(["missing", "denied"] as const)(
  "copies with %s async clipboard access and restores the editor selection",
  async (access) => {
    vi.stubGlobal("navigator", {
      clipboard:
        access === "missing"
          ? undefined
          : { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
    });
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    editor.textContent = "Keep this selection";
    document.body.append(editor);
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild!, 5);
    range.setEnd(editor.firstChild!, 9);
    document.getSelection()!.addRange(range);
    let copied = "";
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: (command: string) => {
        expect(command).toBe("copy");
        copied = (document.activeElement as HTMLTextAreaElement).value;
        return true;
      },
    });

    expect(await copyTextToClipboard("https://myoxus.test/document")).toBe(
      true,
    );
    expect(copied).toBe("https://myoxus.test/document");
    expect(document.activeElement).toBe(editor);
    expect(document.getSelection()!.toString()).toBe("this");
    expect(document.querySelector("textarea")).toBeNull();
  },
);
