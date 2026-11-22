import { getInlineEditorByModel } from "@virgultum/content/rich-text";
import type { MyoxusInlineEditor } from "@virgultum/core/types";
import {
  TextSelection,
  type UIEventStateContext,
  WidgetComponent,
} from "@virgultum/core/runtime";
import { InlineEditor } from "@virgultum/core/runtime/inline";

import { findSlashMenuTriggerSuffix, isSlashMenuTriggerInput } from "./consts";
import { SlashMenuExtension } from "./extensions";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import { nothing } from "lit";
import type { SlashMenuItem } from "@virgultum/core/slash-menu";
import { SlashSession } from "./slash-session";
import type { EditorSlashControls } from "@virgultum/core/services";
export class MyoxusSlashMenuWidget extends WidgetComponent {
  private session?: SlashSession;
  private externalMenu = false;
  private request = 0;
  private readonly _getInlineEditor = (evt: CompositionEvent | InputEvent) => {
    if (evt.target instanceof HTMLElement) {
      const editor = (
        evt.target.closest(".inline-editor") as {
          inlineEditor?: MyoxusInlineEditor;
        }
      )?.inlineEditor;
      if (editor instanceof InlineEditor) {
        return editor;
      }
    }

    const textSelection = this.host.selection.find(TextSelection);
    if (!textSelection) return;

    const model = this.host.store.getBlock(textSelection.blockId)?.model;
    if (!model) return;

    return getInlineEditorByModel(this.std, model);
  };

  /** Resume an already committed trigger after a Page renderer handoff. */
  readonly openAtCaret = (
    inlineEditor: InlineEditor,
    triggerEnd?: number,
    present?: (controls: EditorSlashControls | null) => void,
  ) => {
    if (!this.isConnected || this.std.store.readonly) return;
    const textSelection = this.host.selection.find(TextSelection);
    if (!textSelection) return;

    const block = this.host.view.getBlock(textSelection.blockId);
    if (!block) return;
    const model = block.model;

    if (
      getInlineEditorByModel(this.std, model) !== inlineEditor ||
      this.config.disableWhen?.({ model, std: this.std })
    )
      return;

    const inlineRange = inlineEditor.getInlineRange();
    if (!inlineRange) return;

    const textPoint = inlineEditor.getTextPoint(inlineRange.index);
    if (!textPoint) return;

    const [leafStart, offsetStart] = textPoint;

    const text = leafStart.textContent
      ? leafStart.textContent.slice(0, offsetStart)
      : "";

    const triggerKey = findSlashMenuTriggerSuffix(
      triggerEnd === undefined
        ? text
        : inlineEditor.yText.toString().slice(0, triggerEnd),
    );
    if (!triggerKey) return;

    this.session?.cancel();
    const session = new SlashSession(
      { model, std: this.std },
      inlineEditor,
      triggerKey,
      this.config,
      this.configItemTransform,
      triggerEnd,
    );
    this.session = session;
    this.externalMenu = !!present;
    if (!session.getSnapshot().open) return;
    present?.(session);
    this.requestUpdate();
    const unsubscribe = session.subscribe(() => {
      if (!session.getSnapshot().open) {
        unsubscribe();
        present?.(null);
      }
      this.requestUpdate();
    });
  };

  private readonly _onCompositionEnd = (ctx: UIEventStateContext) => {
    const event = ctx.get("defaultState").event as CompositionEvent;

    if (!isSlashMenuTriggerInput(event.data)) return;

    const inlineEditor = this._getInlineEditor(event);
    if (!inlineEditor) return;

    this.request++;
    this.openAtCaret(inlineEditor);
  };

  private readonly _onBeforeInput = (ctx: UIEventStateContext) => {
    const event = ctx.get("defaultState").event;
    if (!(event instanceof InputEvent)) return;

    // Skip non-character inputs and IME composition (handled by _onCompositionEnd)
    if (event.data === null || event.isComposing) return;

    // Quick check: only proceed if the input contains the trigger key
    if (!isSlashMenuTriggerInput(event.data)) return;

    const inlineEditor = this._getInlineEditor(event);
    if (!inlineEditor) return;

    // Wait for the input to be processed, then handle it
    const request = ++this.request;
    inlineEditor
      .waitForUpdate()
      .then(() => {
        if (request === this.request) this.openAtCaret(inlineEditor);
      })
      .catch(console.error);
  };

  get config() {
    return this.std.get(SlashMenuExtension).config;
  }

  // TODO(@L-Sun): Remove this when moving each config item to corresponding blocks
  // This is a temporary way for patching the slash menu config
  configItemTransform: (item: SlashMenuItem) => SlashMenuItem = (item) => item;

  override createRenderRoot() {
    return this;
  }
  override render() {
    return !this.externalMenu && this.session?.getSnapshot().open
      ? (this.std
          .getOptional(EditorChromeHostIdentifier)
          ?.renderSlash(this.session) ?? nothing)
      : nothing;
  }
  override connectedCallback() {
    super.connectedCallback();

    this.handleEvent("beforeInput", this._onBeforeInput);
    this.handleEvent("compositionEnd", this._onCompositionEnd);
    this.disposables.add(() => {
      this.request++;
      this.session?.cancel();
    });
  }
}
