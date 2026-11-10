// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Link,
  RichTextEditor as MantineRichTextEditor,
  type RichTextEditorLabels,
} from "@mantine/tiptap";
import type { JSONContent } from "@tiptap/core";
import { useEditor } from "@tiptap/react";
import { Bold } from "@tiptap/extension-bold";
import { Code } from "@tiptap/extension-code";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Italic } from "@tiptap/extension-italic";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Strike } from "@tiptap/extension-strike";
import { Text } from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { type FocusEventHandler, useEffect, useMemo } from "react";

export type MyoxusRichTextDocument = JSONContent;

export type RichTextInputLabels = Partial<RichTextEditorLabels>;

export type RichTextInputProps = {
  "aria-label": string;
  autoFocus?: boolean;
  labels?: RichTextInputLabels;
  readOnly?: boolean;
  /** Native Mantine content presentation without input chrome; used with readOnly. */
  unstyled?: boolean;
  value: MyoxusRichTextDocument;
  onChange: (value: MyoxusRichTextDocument) => void;
  onFocus?: FocusEventHandler<HTMLDivElement>;
};

const EMPTY_RICH_TEXT_DOCUMENT: MyoxusRichTextDocument = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/**
 * Removes Tiptap's presentation-only Link attributes before persistence. The
 * Database server accepts only the normalized href and remains authoritative
 * for the complete RichText schema.
 */
function canonicalRichTextDocument(value: JSONContent): JSONContent {
  return {
    type: value.type,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(value.marks?.length
      ? {
          marks: value.marks.map((mark) => ({
            type: mark.type,
            ...(mark.type === "link" && typeof mark.attrs?.href === "string"
              ? { attrs: { href: mark.attrs.href } }
              : {}),
          })),
        }
      : {}),
    ...(value.content?.length
      ? { content: value.content.map(canonicalRichTextDocument) }
      : {}),
  };
}

/**
 * Mantine/Tiptap-backed editor for bounded inline RichText cells. Product code
 * supplies domain copy and persistence only; editor chrome and interaction
 * remain native Facade behavior.
 */
export function RichTextInput({
  "aria-label": ariaLabel,
  autoFocus = false,
  labels,
  onChange,
  onFocus,
  readOnly = false,
  unstyled = false,
  value,
}: RichTextInputProps) {
  const extensions = useMemo(
    () => [
      // Keep the Database's bounded schema explicit. StarterKit also installs
      // block/list extensions that this field deliberately does not support.
      Bold,
      Code,
      Document.extend({
        addKeyboardShortcuts() {
          // Browser document navigation escapes nested editable roots in Page.
          return {
            "Mod-Home": () => this.editor.commands.focus("start"),
            "Mod-End": () => this.editor.commands.focus("end"),
            "Mod-Shift-Home": () =>
              this.editor.commands.setTextSelection({
                from: this.editor.state.selection.anchor,
                to: 0,
              }),
            "Mod-Shift-End": () =>
              this.editor.commands.setTextSelection({
                from: this.editor.state.selection.anchor,
                to: this.editor.state.doc.content.size,
              }),
          };
        },
      }),
      HardBreak,
      UndoRedo,
      Italic,
      Paragraph,
      Strike,
      Text,
      Link.configure({
        autolink: false,
        linkOnPaste: false,
        openOnClick: false,
        protocols: ["http", "https", "mailto"],
      }),
    ],
    [],
  );
  const editor = useEditor({
    // Tiptap owns focus after its deferred editor view has mounted.
    autofocus: autoFocus && !readOnly ? "end" : false,
    content: canonicalRichTextDocument(value ?? EMPTY_RICH_TEXT_DOCUMENT),
    editable: !readOnly,
    extensions,
    immediatelyRender: false,
    onUpdate: ({ editor: activeEditor }) => {
      onChange(canonicalRichTextDocument(activeEditor.getJSON()));
    },
  });

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor) return;
    const next = canonicalRichTextDocument(value ?? EMPTY_RICH_TEXT_DOCUMENT);
    if (
      JSON.stringify(canonicalRichTextDocument(editor.getJSON())) !==
      JSON.stringify(next)
    ) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [editor, value]);

  return (
    <MantineRichTextEditor
      aria-label={ariaLabel}
      editor={editor}
      unstyled={unstyled}
      labels={labels}
      withCodeHighlightStyles={false}
      data-myoxus-ui-role="input:rich-text"
      onFocus={onFocus}
    >
      {!readOnly ? (
        <MantineRichTextEditor.Toolbar sticky>
          <MantineRichTextEditor.ControlsGroup>
            <MantineRichTextEditor.Bold />
            <MantineRichTextEditor.Italic />
            <MantineRichTextEditor.Strikethrough />
            <MantineRichTextEditor.Code />
          </MantineRichTextEditor.ControlsGroup>
          <MantineRichTextEditor.ControlsGroup>
            <MantineRichTextEditor.Link />
            <MantineRichTextEditor.Unlink />
          </MantineRichTextEditor.ControlsGroup>
          <MantineRichTextEditor.ControlsGroup>
            <MantineRichTextEditor.Undo />
            <MantineRichTextEditor.Redo />
          </MantineRichTextEditor.ControlsGroup>
        </MantineRichTextEditor.Toolbar>
      ) : null}
      <MantineRichTextEditor.Content />
    </MantineRichTextEditor>
  );
}
