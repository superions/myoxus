// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { RichText } from "@virgultum/editor/rich-text";
import { type EditorHost, TextSelection } from "@virgultum/editor/std";

import { handleInlineAskAIAction } from "../../actions/doc-handler";
import { AIProvider } from "../../provider";
import type { AIPanelController } from "../../widgets/ai-panel/controller";

function isDirectSpaceKeypress(event: KeyboardEvent): boolean {
  return event.key === " " && event.which === 32 && !event.isComposing;
}

function insertLiteralSpace(host: EditorHost): void {
  const selection = host.selection.find(TextSelection);
  if (!selection?.isCollapsed()) return;

  const block = host.view.getBlock(selection.from.blockId);
  const richText = block?.querySelector("rich-text") as RichText | null;
  richText?.inlineEditor?.insertText(
    { index: selection.from.index, length: 0 },
    " ",
  );
}

/**
 * Opens inline Ask AI when pressing Space at index 0 of an empty paragraph.
 * Uses `keyPress` (`which === 32`) so IME candidate confirmation does not
 * masquerade as an intentional leading space shortcut.
 */
export function setupSpaceAIEntry(panel: AIPanelController): void {
  panel.disposables.add(
    panel.std.event.add("keyPress", (ctx) => {
      const event = ctx.get("keyboardState").raw;
      if (!AIProvider.actions.chat || !isDirectSpaceKeypress(event)) return;

      const { host } = panel;
      if (panel.state === "input") {
        if (panel.inputElement?.value.trim() === "") {
          event.preventDefault();
          insertLiteralSpace(host);
          panel.hide();
        }
        return;
      }

      const selection = host.selection.find(TextSelection);
      if (!selection?.isCollapsed() || selection.from.index !== 0) return;

      const block = host.view.getBlock(selection.blockId);
      if (
        !block?.model?.text ||
        block.model.text.length > 0 ||
        block.model.flavour !== "myoxus:paragraph"
      ) {
        return;
      }

      event.preventDefault();
      handleInlineAskAIAction(host);
    }),
  );
}
