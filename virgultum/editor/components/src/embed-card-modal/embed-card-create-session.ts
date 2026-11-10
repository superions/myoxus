// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EditorChromeHostIdentifier,
  EmbedOptionProvider,
  mountInlinePopup,
} from "@virgultum/shared/services";
import { isValidUrl } from "@virgultum/shared/utils";
import type { EditorHost } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import type { BlockModel } from "@virgultum/store";

type CreateOptions =
  | {
      mode: "page";
      parentModel: BlockModel | string;
      index?: number;
      sourceBlockId: string;
    }
  | { mode: "edgeless"; onSave: (url: string) => void };

/** False means dismissal; callers may remove the source paragraph only on true. */
export function toggleEmbedCardCreateModal(
  editor: EditorHost,
  title: string,
  description: string,
  options: CreateOptions,
  onConfirm: (result: { mode: "page" | "edgeless" }) => void,
): Promise<boolean> {
  const { std, store } = editor;
  const chrome = std.getOptional(EditorChromeHostIdentifier);
  const abort = new AbortController();
  const parentId =
    options.mode === "page"
      ? typeof options.parentModel === "string"
        ? options.parentModel
        : options.parentModel.id
      : undefined;
  const valid = () =>
    editor.isConnected &&
    !store.readonly &&
    (parentId === undefined || !!store.getBlock(parentId));
  if (!chrome || !valid()) return Promise.resolve(false);
  const selection = [...editor.selection.value];
  let inserted = false;
  editor.selection.clear();
  return new Promise<boolean>((resolve) => {
    abort.signal.addEventListener("abort", () => resolve(inserted), {
      once: true,
    });
    mountInlinePopup(
      std,
      () => (valid() ? editor : null),
      (controls) =>
        chrome.renderEmbedCardCreate({
          ...controls,
          title,
          description,
          isValidUrl,
          confirm: (url) => {
            if (abort.signal.aborted || !valid() || !isValidUrl(url)) return;
            if (options.mode === "page") {
              const flavour =
                std.get(EmbedOptionProvider).getEmbedBlockOptions(url)
                  ?.flavour ?? "myoxus:bookmark";
              store.addBlock(
                flavour as never,
                { url },
                options.parentModel,
                options.index,
              );
            } else {
              if (!std.get(GfxControllerIdentifier).surface) return;
              options.onSave(url);
            }
            inserted = true;
            try {
              onConfirm({ mode: options.mode });
            } finally {
              controls.close();
            }
          },
        }),
      abort,
      () => {
        if (editor.isConnected) {
          std.event.active = true;
          if (!inserted)
            editor.selection.set(
              selection.filter((item) => !!store.getBlock(item.blockId)),
            );
          editor.focus({ preventScroll: true });
          const inline =
            !inserted && options.mode === "page"
              ? std.range.queryInlineEditorByPath(options.sourceBlockId)
              : null;
          if (inline?.rootElement?.isConnected && !store.readonly) {
            const range = { index: inline.yTextLength, length: 0 };
            inline.rootElement.focus({ preventScroll: true });
            inline.setInlineRange(range);
            inline.syncInlineRange(range);
          }
        }
      },
    );
  });
}
