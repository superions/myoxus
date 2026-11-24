// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type BlockModel, Text } from "@virgultum/core/store";
import { useState } from "react";
import { EditorBlockCaption } from "../../view-extensions/editor-view/editor-chrome/block-caption";
import { restorePageRange } from "./plain-page-input";

export function usePageCaption(
  model: BlockModel<{ caption?: string | null }>,
  readonly: boolean,
) {
  const [focusRequest, requestFocus] = useState(0);
  const { store } = model;
  const writable = () =>
    !readonly && !store.readonly && store.getModelById(model.id) === model;

  return {
    show: () => {
      if (writable()) requestFocus((n) => n + 1);
    },
    field:
      focusRequest || model.props.caption ? (
        <EditorBlockCaption
          controls={{
            getSnapshot: () => model.props.caption$.value ?? "",
            subscribe: (listener) => model.props.caption$.subscribe(listener),
            readonly: readonly || store.readonly,
            focusRequest,
            setFocused: (focused) => {
              requestFocus((n) => (focused ? n || 1 : 0));
            },
            change: (caption) => {
              if (writable()) store.updateBlock(model, { caption });
            },
            enter: (input) => {
              const root = input.closest<HTMLElement>("[data-page-renderer]");
              const parent = store.getParent(model);
              if (!root || !parent || !writable()) return false;
              const offset = input.selectionStart;
              const head = input.value.slice(0, offset);
              const tail = new Text(input.value.slice(offset));
              let id: string;
              // The caption split and the following paragraph form one undo step.
              store.captureSync();
              store.transact(() => {
                store.updateBlock(model, { caption: head });
                id = store.addBlock(
                  "myoxus:paragraph",
                  { text: tail },
                  parent,
                  parent.children.indexOf(model) + 1,
                );
              });
              store.captureSync();
              input.blur();
              requestAnimationFrame(() => {
                if (!root.querySelector(`[data-page-text="${CSS.escape(id)}"]`))
                  return;
                root.querySelector<HTMLElement>("[data-page-body]")?.focus();
                const point = { id, offset: 0 };
                restorePageRange(root, { anchor: point, focus: point });
              });
              return true;
            },
          }}
        />
      ) : null,
  };
}
