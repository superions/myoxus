// SPDX-License-Identifier: AGPL-3.0-or-later
import { mountEditorPortal } from "@virgultum/core/view/portal";
import {
  insertLocalFootnote,
  localFootnoteDefinitions,
  localFootnotePresentation,
  localFootnoteInsertionNote,
  localFootnoteCaret,
} from "@virgultum/core/commands";
import {
  editorMessage,
  FootnoteReactHostIdentifier,
} from "@virgultum/core/services";
import { TextSelection } from "@virgultum/core/runtime";
import type {
  SlashMenuConfig,
  SlashMenuActionItem,
} from "@virgultum/core/slash-menu";

export const footnoteSlashMenuConfig: SlashMenuConfig = {
  items: (["footnote", "endnote"] as const).map(
    (placement): SlashMenuActionItem => ({
      id: `local-${placement}-insert`,
      label:
        placement === "endnote"
          ? editorMessage("com.myoxus.editor.endnote", "Endnote")
          : editorMessage("com.myoxus.editor.footnote", "Footnote"),
      icon: "FileTextIcon",
      group: {
        id: "basic",
        label: editorMessage("com.myoxus.editor.group.basic", "Basic"),
        order: 0,
        itemOrder: placement === "footnote" ? 11 : 12,
      },
      when: ({ std, model }) =>
        !model.store.readonly &&
        !!localFootnoteInsertionNote(model.store, model) &&
        !!std.getOptional(FootnoteReactHostIdentifier),
      action: ({ std, model }) => {
        const selection = std.selection.find(TextSelection);
        const host = std.getOptional(FootnoteReactHostIdentifier);
        const reference = std.view.getBlock(model.id);
        if (
          !model.text ||
          selection?.from.blockId !== model.id ||
          !host ||
          !reference ||
          model.store.readonly
        )
          return;
        const index = localFootnoteCaret(model, selection.from.index);
        const presentation = localFootnotePresentation(model.store);
        const controller = new AbortController();
        mountEditorPortal(
          reference.ownerDocument.body,
          controller,
          (anchor) =>
            host.mountInsertion(anchor, {
              placement,
              definitions: localFootnoteDefinitions(model.store)
                .filter(
                  (definition) =>
                    presentation.get(definition.id)?.placement === placement,
                )
                .map((definition) => ({
                  id: definition.id,
                  ...presentation.get(definition.id),
                  excerpt: definition.children
                    .map((child) => child.text?.toString() ?? "")
                    .join(" ")
                    .slice(0, 80),
                })),
              choose: (id) => {
                const offset = index();
                if (offset !== undefined)
                  insertLocalFootnote(std, model, offset, id, placement);
                controller.abort();
              },
              cancel: () => {
                const offset = index();
                if (offset !== undefined) {
                  std.event.active = true;
                  std.selection.setGroup("note", [
                    std.selection.create(TextSelection, {
                      from: { blockId: model.id, index: offset, length: 0 },
                      to: null,
                    }),
                  ]);
                }
                controller.abort();
              },
            }),
          { referenceElement: reference, placement: "bottom-start" },
        );
      },
    }),
  ),
};
