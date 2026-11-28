// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { getInlineEditorByModel } from "@virgultum/content/rich-text";
import type { Container } from "@virgultum/core/primitives/di";
import {
  type BlockStdScope,
  NativeEditorWidget,
  StdIdentifier,
  TextSelection,
  type UIEventStateContext,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
import { InlineEditor } from "@virgultum/core/runtime/inline";
import {
  EditorChromeHostIdentifier,
  type EditorSlashControls,
} from "@virgultum/core/services";
import {
  type SlashMenuConfig,
  SlashMenuConfigExtension,
  SlashMenuConfigIdentifier,
  type SlashMenuItem,
} from "@virgultum/core/slash-menu";
import { Extension } from "@virgultum/core/store";
import type { MyoxusInlineEditor } from "@virgultum/core/types";

import {
  defaultSlashMenuConfig,
  hasSlashTriggerChar,
  matchSlashTriggerSuffix,
  MYOXUS_SLASH_MENU_WIDGET,
} from "./slash-config";
import { mergeSlashMenuConfigs } from "./slash-items";
import { SlashSession } from "./slash-session";

/**
 * Registers the slash-menu widget on `myoxus:page` and merges all registered
 * `SlashMenuConfigIdentifier` providers into one live configuration.
 */
export class SlashMenuExtension extends Extension {
  readonly config: SlashMenuConfig;

  static override setup(di: Container): void {
    WidgetViewExtension(
      "myoxus:page",
      MYOXUS_SLASH_MENU_WIDGET,
      MYOXUS_SLASH_MENU_WIDGET,
    ).setup(di);
    di.add(this, [StdIdentifier]);
    SlashMenuConfigExtension("default", defaultSlashMenuConfig).setup(di);
  }

  constructor(readonly std: BlockStdScope) {
    super();
    this.config = mergeSlashMenuConfigs(
      this.std.provider.getAll(SlashMenuConfigIdentifier),
    );
  }
}

/**
 * Headless Edgeless/host slash trigger widget delegating menu UI to
 * `EditorChromeHostIdentifier.mountSlash` on top of `SlashSession`.
 */
export class MyoxusSlashMenuWidget extends NativeEditorWidget {
  private activeSession: SlashSession | null = null;
  private triggerSequence = 0;

  configItemTransform: (item: SlashMenuItem) => SlashMenuItem = (item) => item;

  get config(): SlashMenuConfig {
    return this.std.get(SlashMenuExtension).config;
  }

  override connectedCallback(): void {
    super.connectedCallback();

    this.handleEvent("beforeInput", this.handleBeforeInput);
    this.handleEvent("compositionEnd", this.handleCompositionEnd);
    this.disposables.add(() => {
      this.triggerSequence += 1;
      this.activeSession?.cancel();
      this.activeSession = null;
    });
  }

  /**
   * Opens a `SlashSession` at the current caret when the text before the caret
   * ends with a supported trigger key. Optionally hands controls to `present`.
   */
  readonly openAtCaret = (
    inlineEditor: InlineEditor,
    triggerEnd?: number,
    present?: (controls: EditorSlashControls | null) => void,
  ): void => {
    if (!this.isConnected || this.std.store.readonly) return;

    const textSelection = this.host.selection.find(TextSelection);
    if (!textSelection) return;

    const block = this.host.view.getBlock(textSelection.blockId);
    if (!block) return;

    const { model } = block;
    if (
      getInlineEditorByModel(this.std, model) !== inlineEditor ||
      this.config.disableWhen?.({ model, std: this.std })
    ) {
      return;
    }

    const inlineRange = inlineEditor.getInlineRange();
    if (!inlineRange) return;

    const textPoint = inlineEditor.getTextPoint(inlineRange.index);
    if (!textPoint) return;

    const [leafNode, leafOffset] = textPoint;
    const prefix =
      triggerEnd === undefined
        ? (leafNode.textContent ?? "").slice(0, leafOffset)
        : inlineEditor.yText.toString().slice(0, triggerEnd);

    const triggerKey = matchSlashTriggerSuffix(prefix);
    if (!triggerKey) return;

    this.activeSession?.cancel();
    const session = new SlashSession(
      { model, std: this.std },
      inlineEditor,
      triggerKey,
      this.config,
      this.configItemTransform,
      triggerEnd,
    );
    this.activeSession = session;

    if (!session.getSnapshot().open) {
      this.activeSession = null;
      return;
    }

    const unmount = present
      ? undefined
      : this.std
          .getOptional(EditorChromeHostIdentifier)
          ?.mountSlash(this, session);

    const unsubscribe = session.subscribe(() => {
      if (session.getSnapshot().open) return;
      unsubscribe();
      unmount?.();
      present?.(null);
      if (this.activeSession === session) {
        this.activeSession = null;
      }
    });

    present?.(session);
  };

  private resolveInlineEditor(
    event: CompositionEvent | InputEvent,
  ): MyoxusInlineEditor | undefined {
    if (event.target instanceof HTMLElement) {
      const candidate = (
        event.target.closest(".inline-editor") as {
          inlineEditor?: MyoxusInlineEditor;
        } | null
      )?.inlineEditor;
      if (candidate instanceof InlineEditor) {
        return candidate;
      }
    }

    const textSelection = this.host.selection.find(TextSelection);
    if (!textSelection) return undefined;

    const model = this.host.store.getBlock(textSelection.blockId)?.model;
    return model
      ? (getInlineEditorByModel(this.std, model) ?? undefined)
      : undefined;
  }

  private readonly handleCompositionEnd = (ctx: UIEventStateContext): void => {
    const event = ctx.get("defaultState").event as CompositionEvent;
    if (!hasSlashTriggerChar(event.data)) return;

    const inlineEditor = this.resolveInlineEditor(event);
    if (!inlineEditor) return;

    this.triggerSequence += 1;
    this.openAtCaret(inlineEditor);
  };

  private readonly handleBeforeInput = (ctx: UIEventStateContext): void => {
    const event = ctx.get("defaultState").event;
    if (!(event instanceof InputEvent)) return;
    if (event.data === null || event.isComposing) return;
    if (!hasSlashTriggerChar(event.data)) return;

    const inlineEditor = this.resolveInlineEditor(event);
    if (!inlineEditor) return;

    const sequence = ++this.triggerSequence;
    inlineEditor
      .waitForUpdate()
      .then(() => {
        if (sequence === this.triggerSequence) {
          this.openAtCaret(inlineEditor);
        }
      })
      .catch(console.error);
  };
}

export function registerSlashMenuWidget(): void {
  if (!customElements.get(MYOXUS_SLASH_MENU_WIDGET)) {
    customElements.define(MYOXUS_SLASH_MENU_WIDGET, MyoxusSlashMenuWidget);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_SLASH_MENU_WIDGET]: MyoxusSlashMenuWidget;
  }
}
