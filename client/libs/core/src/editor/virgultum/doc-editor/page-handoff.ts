// SPDX-License-Identifier: AGPL-3.0-or-later
import { TextSelection } from "@virgultum/core/runtime";
import type { EditorSlashControls } from "@virgultum/core/services";
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
  saved: PageBookmark,
  intent: PageIntent | undefined,
  signal: AbortSignal,
  takeText: () => string,
  presentSlash: (controls: EditorSlashControls | null) => void,
) {
  try {
    const { std, page } = editor;
    await editor.updateComplete;
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
      const widget = editor.host.querySelector("myoxus-toolbar-widget") as
        (HTMLElement & { toolbar: HTMLElement | null }) | null;
      if (!widget) return;
      // Resolve only in the receiving scope's actual portal. It owns command
      // availability, its target range, and any menu or dialog return focus.
      const activate = () => {
        const button = widget.toolbar?.querySelector<HTMLButtonElement>(
          `button[data-testid="${CSS.escape(intent.control!)}"]`,
        );
        if (!button || button.disabled || signal.aborted || page.readonly)
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
