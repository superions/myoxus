// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect, signal } from "@preact/signals-core";
import {
  BLOCK_CHILDREN_CONTAINER_PADDING_LEFT,
  EDGELESS_TOP_CONTENTEDITABLE_SELECTOR,
  TOGGLE_BUTTON_PARENT_CLASS,
} from "@virgultum/core/consts";
import type {
  ListBlockModel,
  ParagraphBlockModel,
} from "@virgultum/core/models";
import {
  NativeContainerBlock,
  type BlockComponent,
} from "@virgultum/core/runtime";
import { getInlineRangeProvider } from "@virgultum/core/runtime/inline";
import {
  DocModeProvider,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  textProtectionHint,
} from "@virgultum/core/services";
import { getViewportElement } from "@virgultum/core/utils";
import { DefaultInlineManagerExtension } from "../inlines/preset/index";
import { selectionFrame } from "../caption/selection-frame";
import type { RichText } from "./rich-text";

/** Keep the input mounted while updating the block chrome and projecting children. */
export abstract class TextBlock<
  Model extends ParagraphBlockModel | ListBlockModel,
> extends NativeContainerBlock<Model> {
  private readonly readonlyCollapsed = signal(false);
  protected richText?: RichText;
  protected abstract mountControls(
    container: HTMLElement,
    line: HTMLElement,
    input: RichText,
  ): void;
  protected abstract showDisclosure(): boolean;

  get inlineManager() {
    return this.std.get(DefaultInlineManagerExtension.identifier);
  }
  get attributeRenderer() {
    return this.inlineManager.getRenderer();
  }
  get attributesSchema() {
    return this.inlineManager.getSchema();
  }
  get embedChecker() {
    return this.inlineManager.embedChecker;
  }
  get inlineEditor() {
    return this.richText?.inlineEditor;
  }
  override get topContenteditableElement() {
    return this.std.get(DocModeProvider).getEditorMode() === "edgeless"
      ? this.closest<BlockComponent>(EDGELESS_TOP_CONTENTEDITABLE_SELECTOR)
      : this.rootComponent;
  }
  protected get collapsed() {
    return this.store.readonly
      ? this.readonlyCollapsed.value
      : this.model.props.collapsed$.value;
  }
  protected setCollapsed(value: boolean) {
    if (this.store.readonly) this.readonlyCollapsed.value = value;
    else {
      this.store.captureSync();
      this.model.props.collapsed = value;
    }
  }
  override get updateComplete() {
    return Promise.all([
      super.updateComplete,
      this.richText?.updateComplete,
    ]).then(([complete]) => complete);
  }
  protected mountBody() {
    const doc = this.ownerDocument;
    const kind = this.localName;
    const container = doc.createElement("div");
    container.className = kind + "-block-container";
    const line = doc.createElement("div");
    line.className = kind + "-rich-text-wrapper " + TOGGLE_BUTTON_PARENT_CLASS;
    const input = doc.createElement("rich-text");
    this.richText = input;
    input.attributeRenderer = this.attributeRenderer;
    input.attributesSchema = this.attributesSchema;
    input.embedChecker = this.embedChecker;
    input.markdownMatches = this.inlineManager.markdownMatches;
    input.undoManager = this.store.history.undoManager;
    input.inlineRangeProvider = getInlineRangeProvider(this) ?? undefined;
    input.inlineEventSource = this.topContenteditableElement ?? undefined;
    input.verticalScrollContainerGetter = () => getViewportElement(this.host);
    input.enableClipboard = false;
    input.enableUndoRedo = false;
    const children = doc.createElement("div");
    children.className = "myoxus-block-children-container";
    children.style.paddingLeft = BLOCK_CHILDREN_CONTAINER_PADDING_LEFT + "px";
    line.append(input);
    container.append(line, children);

    this.disposables.add(
      effect(() => {
        this.readonlyCollapsed.value = this.model.props.collapsed$.value;
      }),
    );
    this.disposables.add(
      effect(() => {
        const props = this.model.props;
        input.yText = props.text$.value.yText;
        input.readonly =
          this.store.readonly || props.textProtection$?.value === "fixed";
        input.title = textProtectionHint(
          props.textProtection$?.value,
          this.std.getOptional(EditorI18nProvider) ?? undefined,
        );
        container.style.textAlign = props.textAlign$?.value ?? "";
        children.style.display = this.collapsed ? "none" : "";
      }),
    );
    const disclosure = doc.createElement("virgultum-toggle-button");
    disclosure.chromeHost = this.std.getOptional(EditorChromeHostIdentifier);
    disclosure.updateCollapsed = (value) => this.setCollapsed(value);
    this.disposables.add(
      effect(() => {
        if (this.showDisclosure()) {
          disclosure.collapsed = this.collapsed;
          if (!disclosure.parentNode) line.prepend(disclosure);
        } else disclosure.remove();
      }),
    );
    this.mountControls(container, line, input);
    const frame = selectionFrame(this, container);
    frame.style.margin = "var(--" + kind + "-margin, 10px 0)";
    this.append(frame);
    this.mountBlockWidgets(container);
    return children;
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.richText = undefined;
  }
}
