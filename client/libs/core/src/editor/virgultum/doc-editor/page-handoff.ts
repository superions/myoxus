// SPDX-License-Identifier: AGPL-3.0-or-later
import { BlockSelection, TextSelection } from "@virgultum/core/runtime";
import { ImageSelection } from "@virgultum/core/selection";
import { createAbsolutePositionFromRelativePosition } from "yjs";
import {
  ToolbarRegistryIdentifier,
  CommentProviderIdentifier,
  type EditorSlashControls,
} from "@virgultum/core/services";
import { getInlineEditorByModel } from "@virgultum/editor/rich-text";
import type { MyoxusEditorContainer } from "./virgultum-editor";
import {
  resolveBookmark,
  type PageBookmark,
  type PageIntent,
} from "./plain-page-input";

/** Resume only on the mounted receiver. The Y document, its history and the
 * pending transport have not been replaced during asynchronous loading. */
export async function resumePageIntent(
  editor: MyoxusEditorContainer,
  saved: PageBookmark | null,
  intent: PageIntent | undefined,
  signal: AbortSignal,
  takeText: () => string,
  presentSlash: (controls: EditorSlashControls | null) => void,
) {
  try {
    const { std, page } = editor;
    await editor.updateComplete;
    if (intent?.kind === "comment-thread") {
      const view = std.view.getBlock(intent.block);
      await view?.updateComplete;
      const text = page.getModelById(intent.block)?.text,
        at = createAbsolutePositionFromRelativePosition(
          intent.point,
          page.spaceDoc,
        );
      // A peer may remove or resolve this occurrence while the comment owner loads.
      if (
        !signal.aborted &&
        view?.isConnected &&
        text &&
        at?.type === text.yText &&
        text.sliceToDelta(at.index, at.index + 1)[0]?.attributes?.[
          `comment-${intent.id}`
        ] === true
      )
        std.getOptional(CommentProviderIdentifier)?.highlightComment(intent.id);
      return;
    }
    if (intent?.kind === "table-cell") {
      const table = std.view.getBlock(intent.id);
      await table?.updateComplete;
      const td = table?.querySelector<HTMLTableCellElement>(
        `[data-row-id="${CSS.escape(intent.row)}"][data-column-id="${CSS.escape(intent.column)}"]`,
      );
      const cell = td?.closest("myoxus-table-cell");
      await cell?.richText$.peek()?.updateComplete;
      if (!td || !cell || !cell.isConnected || signal.aborted || page.readonly)
        return;
      const inline = cell.inlineEditor;
      if (!inline) return;
      const from = createAbsolutePositionFromRelativePosition(
          intent.from,
          page.spaceDoc,
        ),
        to = createAbsolutePositionFromRelativePosition(
          intent.to,
          page.spaceDoc,
        );
      if (
        !from ||
        !to ||
        from.type !== inline.yText ||
        to.type !== inline.yText
      )
        return;
      cell.restoreCellFocus(from.index);
      const range = { index: from.index, length: to.index - from.index };
      if (!inline.isValidInlineRange(range)) return;
      inline.setInlineRange(range);
      inline.syncInlineRange(range);
      if (intent.menu === "cell")
        td.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
      if (intent.menu === "row")
        table
          ?.querySelector<HTMLButtonElement>(
            `[data-drag-row-id="${CSS.escape(intent.row)}"]`,
          )
          ?.click();
      if (intent.paste)
        inline.rootElement?.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: intent.paste,
          }),
        );
      return;
    }
    if (intent?.kind === "block-paste" || intent?.kind === "block-command") {
      const isPaste = intent.kind === "block-paste";
      const block = std.view.getBlock(intent.id);
      await block?.updateComplete;
      if (
        !signal.aborted &&
        block?.isConnected &&
        (!page.readonly ||
          (!isPaste &&
            (intent.clipboard === "copy" ||
              (intent.flavour === "myoxus:code" &&
                intent.control === "copy-code")))) &&
        page.getModelById(intent.id)?.flavour ===
          (isPaste ? "myoxus:divider" : (intent.flavour ?? "myoxus:attachment"))
      ) {
        std.host.focus({ preventScroll: true });
        std.selection.setGroup("note", [
          std.selection.create(BlockSelection, { blockId: intent.id }),
        ]);
        if (!isPaste && intent.control) {
          if (
            block.flavour === "myoxus:image" &&
            intent.control.startsWith("image-key:")
          ) {
            const key = intent.control.slice("image-key:".length);
            std.selection.setGroup("note", [
              std.selection.create(ImageSelection, { blockId: intent.id }),
            ]);
            block.dispatchEvent(
              new KeyboardEvent("keydown", {
                key,
                code: key,
                bubbles: true,
                cancelable: true,
              }),
            );
          } else if (
            block.flavour === "myoxus:embed-iframe" &&
            intent.control === "iframe-input"
          ) {
            const frame =
              block as import("@virgultum/embeds/blocks").EmbedIframeBlockComponent;
            frame.resumeLinkInput();
          } else if (block.flavour === "myoxus:code") {
            const widget = block.querySelector<
              import("@virgultum/editor/blocks/code").MyoxusCodeToolbarWidget
            >("myoxus-code-toolbar-widget");
            await widget?.updateComplete;
            if (!signal.aborted) widget?.runPageCommand(intent.control);
          } else activateToolbar(editor, intent.control, signal);
        } else if (isPaste || intent.clipboard)
          block.dispatchEvent(
            new ClipboardEvent(isPaste ? "paste" : intent.clipboard!, {
              bubbles: true,
              cancelable: true,
              clipboardData: intent.data ?? null,
            }),
          );
      }
      return;
    }
    if (!saved) return;
    const s = resolveBookmark(page, saved);
    if (!s || signal.aborted || !editor.host?.isConnected) return;
    const anchor = std.view.getBlock(s.anchor.id),
      focus = std.view.getBlock(s.focus.id);
    await Promise.all([anchor?.updateComplete, focus?.updateComplete]);
    const inline = getInlineEditorByModel(std, s.focus.id);
    await inline?.waitForUpdate();
    if (signal.aborted || !editor.host?.isConnected || !inline) return;
    const current = resolveBookmark(page, saved);
    if (!current) return;
    const { anchor: a, focus: b } = current;
    // Slash itself was already written by the native owner. Apply only input
    // captured during the swap, before publishing the receiver's final range.
    const queued = takeText();
    if (
      queued &&
      (!intent || intent.kind === "slash") &&
      a.id === b.id &&
      a.offset === b.offset &&
      !page.readonly
    ) {
      inline.insertText({ index: b.offset, length: 0 }, queued);
      a.offset += queued.length;
      b.offset += queued.length;
    }
    const same = a.id === b.id;
    const reverse = same
      ? a.offset > b.offset
      : !!(
          anchor &&
          focus &&
          anchor.compareDocumentPosition(focus) &
            Node.DOCUMENT_POSITION_PRECEDING
        );
    const [start, end] = reverse ? [b, a] : [a, b];
    const selection = std.selection.create(TextSelection, {
      from: {
        blockId: start.id,
        index: start.offset,
        length: same
          ? end.offset - start.offset
          : (page.getModelById(start.id)?.text?.length ?? start.offset) -
            start.offset,
      },
      to: same ? null : { blockId: end.id, index: 0, length: end.offset },
      reverse,
    });
    inline.rootElement?.focus({ preventScroll: true });
    std.selection.setGroup("note", [selection]);
    std.range.syncTextSelectionToRange(selection);
    if (intent?.kind === "link-command" && same) {
      const link = Array.from(
        inline.rootElement?.querySelectorAll<
          import("@virgultum/content/inlines").MyoxusLink
        >("myoxus-link") ?? [],
      ).find((node) => {
        const r = node.selfInlineRange;
        return (
          r?.index === start.offset &&
          r.length === end.offset - start.offset &&
          node.delta.attributes?.link === intent.url
        );
      });
      if (!link) return;
      if (intent.action === "open")
        link.openLink(new MouseEvent("click", { button: intent.button }));
      else if (!page.readonly) {
        std.get(ToolbarRegistryIdentifier).message$.value = {
          flavour: "myoxus:link",
          element: link,
          setFloating: () => {},
        };
        activateToolbar(editor, "c.conversions", signal);
      }
      return;
    }
    if (intent?.kind === "range-clipboard") {
      if (intent.action === "copy" || !page.readonly)
        inline.rootElement?.dispatchEvent(
          new ClipboardEvent(intent.action, {
            bubbles: true,
            cancelable: true,
          }),
        );
    }
    if (!intent || page.readonly) return;
    if (intent.kind === "input")
      inline.rootElement?.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: intent.inputType,
          data: intent.data,
        }),
      );
    if (intent.kind === "key")
      inline.rootElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          ...intent,
          bubbles: true,
          cancelable: true,
        }),
      );
    if (intent.kind === "selection" && intent.control) {
      activateToolbar(editor, intent.control, signal);
    }
    if (intent.kind === "paste")
      inline.rootElement?.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: intent.data,
        }),
      );
    if (intent.kind === "slash" && same) {
      inline.setInlineRange({ index: b.offset, length: 0 });
      const start = resolveBookmark(page, intent.start)?.focus;
      if (
        start?.id !== b.id ||
        start.offset > b.offset ||
        inline.yText
          .toString()
          .slice(start.offset - intent.trigger.length, start.offset) !==
          intent.trigger
      )
        return;
      const widget = editor.host.querySelector("myoxus-slash-menu-widget") as
        | (HTMLElement & {
            openAtCaret(
              editor: typeof inline,
              at: number,
              present: typeof presentSlash,
            ): void;
          })
        | null;
      widget?.openAtCaret(inline, start.offset, presentSlash);
    }
    if (
      queued &&
      intent.kind !== "slash" &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement.isContentEditable
    ) {
      document.activeElement.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: queued,
        }),
      );
    }
  } finally {
    takeText();
  }
}

function activateToolbar(
  editor: MyoxusEditorContainer,
  control: string,
  signal: AbortSignal,
) {
  const widget = editor.host?.querySelector("myoxus-toolbar-widget") as
    (HTMLElement & { toolbar: HTMLElement | null }) | null;
  if (!widget) return;
  // Resolve only in the receiving scope's actual portal. It owns command
  // availability, its target range, and any menu or dialog return focus.
  const activate = () => {
    const button = widget.toolbar?.querySelector<HTMLButtonElement>(
      `button[data-testid="${CSS.escape(control)}"]`,
    );
    if (!button || button.disabled || signal.aborted || editor.page.readonly)
      return false;
    button.click();
    return true;
  };
  if (!activate()) {
    const observer = new MutationObserver(() => {
      if (activate()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const cancel = () => observer.disconnect();
    signal.addEventListener("abort", cancel, { once: true });
    requestAnimationFrame(() => requestAnimationFrame(cancel));
  }
}
