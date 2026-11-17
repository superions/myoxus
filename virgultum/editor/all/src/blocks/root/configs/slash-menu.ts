// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { ParagraphBlockModel } from "@virgultum/core/models";
import {
  getInlineEditorByModel,
  selectTextModel,
} from "@virgultum/content/rich-text";
import {
  combine,
  editorMessage,
  EditorChromeHostIdentifier,
  mountInlinePopup,
  presentToolbarActions,
  ToolbarContext,
  type ToolbarGenericAction,
} from "@virgultum/core/services";
import type {
  SlashMenuConfig,
  SlashMenuContext,
} from "@virgultum/core/slash-menu";
import {
  eyebrowAction,
  createHighlightActionGroup,
  labelToneAction,
} from "./toolbar";

function openFormattingMenu(
  { std, model }: SlashMenuContext,
  action: ToolbarGenericAction,
) {
  const chrome = std.getOptional(EditorChromeHostIdentifier);
  const editor = getInlineEditorByModel(std, model);
  const caret = editor?.getInlineRange();
  if (
    !chrome ||
    !editor ||
    !caret ||
    std.store.readonly ||
    std.store.hasFixedText(model)
  )
    return;
  const live = () =>
    !std.store.readonly &&
    !std.store.hasFixedText(model) &&
    std.store.getModelById(model.id) === model &&
    editor.rootElement?.isConnected;
  // Slash formatting follows the existing whole-line commands. Empty lines retain
  // their caret so the shared formatting command sets marks for the next input.
  const target = { index: 0, length: model.text?.length ?? 0 };
  const restore = (range = caret) => {
    if (!live() || !editor.isValidInlineRange(range)) return;
    selectTextModel(std, model.id, range.index, range.length);
    editor.setInlineRange(range);
    editor.syncInlineRange(range);
  };
  restore(target);
  const ctx = new ToolbarContext(std);
  const [resolved] = presentToolbarActions(combine([action], ctx), ctx);
  if (resolved?.control?.type !== "menu") {
    restore();
    return;
  }
  const abort = new AbortController();
  const actions = resolved.control.items.map((item) => ({
    ...item,
    run: (anchor: HTMLElement, event: MouseEvent) => {
      if (!live()) {
        abort.abort();
        return;
      }
      restore(target);
      std.store.captureSync();
      item.run?.(anchor, event);
      std.store.captureSync();
      abort.abort();
    },
  }));
  mountInlinePopup(
    std,
    () => (live() ? editor.toDomRange(target) : null),
    (controls) =>
      chrome.renderActionMenu({ ...controls, label: resolved.label, actions }),
    abort,
    () => {
      if (live()) {
        std.event.active = true;
        editor.rootElement?.focus({ preventScroll: true });
        restore();
      }
    },
  );
}

export const formattingSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-paragraph-eyebrow",
      label: editorMessage(
        "com.myoxus.editor.paragraph.eyebrow",
        "Small heading",
      ),
      icon: "TextTypeIcon",
      searchAlias: ["eyebrow", "small-heading"],
      group: {
        id: "basic",
        label: editorMessage("com.myoxus.editor.group.basic", "Basic"),
        order: 0,
        itemOrder: 7,
      },
      when: ({ model }) =>
        model instanceof ParagraphBlockModel &&
        model.props.type === "text" &&
        !model.store.readonly &&
        !model.store.hasFixedText(model),
      action: ({ std }) => {
        const ctx = new ToolbarContext(std);
        eyebrowAction.generate(ctx)?.run?.();
      },
    },
    ...(
      [
        {
          id: "text-color",
          label: editorMessage(
            "com.myoxus.editor.toolbar.text-color",
            "Text color",
          ),
          aliases: ["text-color", "color"],
          action: createHighlightActionGroup().actions[0],
        },
        {
          id: "highlight",
          label: editorMessage(
            "com.myoxus.editor.toolbar.text-marker",
            "Text highlight",
          ),
          aliases: [
            "highlight",
            "background-color",
            editorMessage(
              "com.myoxus.editor.toolbar.background-color",
              "Background Color",
            ),
          ],
          action: createHighlightActionGroup(true).actions[1],
        },
        {
          id: "label-tone",
          label: editorMessage(
            "com.myoxus.editor.label-tone.label",
            "Label tone",
          ),
          aliases: ["label-tone"],
          action: labelToneAction,
        },
      ] as const
    ).map(({ id, label, aliases, action }, index) => ({
      id: `inline-format-${id}`,
      label,
      icon:
        id === "text-color"
          ? ("TextColorIcon" as const)
          : id === "highlight"
            ? ("HighLightLinearIcon" as const)
            : ("TagsIcon" as const),
      searchAlias: [...aliases],
      group: {
        id: "style",
        label: editorMessage("com.myoxus.editor.group.style", "Style"),
        order: 2,
        itemOrder: 6 + index,
      },
      when: ({ std, model }: SlashMenuContext) =>
        !std.store.readonly &&
        !std.store.hasFixedText(model) &&
        Boolean(std.getOptional(EditorChromeHostIdentifier)),
      action: (context: SlashMenuContext) =>
        openFormattingMenu(context, action),
    })),
  ],
};
