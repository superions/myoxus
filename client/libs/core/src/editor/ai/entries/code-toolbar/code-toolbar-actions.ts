// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusCodeToolbarWidget } from "@virgultum/editor/blocks/code";
import { BlockSelection } from "@virgultum/editor/std";
import {
  ToolbarContext,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  presentToolbarActions,
} from "@virgultum/editor/shared/services";
import { buildAICodeItemGroups } from "../../_common/config";
import { aiToolbarActions } from "../toolbar-actions";

export function setupCodeToolbarAIEntry(widget: MyoxusCodeToolbarWidget) {
  widget.addPrimaryActions((context) => {
    const toolbar = new ToolbarContext(context.std);
    return [
      {
        id: "ask-ai",
        icon: "AiIcon",
        disabled: context.doc.readonly,
        label: resolveEditorMessage(
          editorMessage("com.myoxus.editor.toolbar.ask-ai", "Ask AI"),
          context.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        control: {
          type: "menu",
          onOpen: () => {
            context.setActive(true);
            context.host.selection.setGroup("note", [
              new BlockSelection({ blockId: context.blockComponent.blockId }),
            ]);
          },
          onClose: () => context.setActive(false),
          items: presentToolbarActions(
            aiToolbarActions(toolbar, buildAICodeItemGroups()),
            toolbar,
          ),
        },
      },
    ];
  });
}
