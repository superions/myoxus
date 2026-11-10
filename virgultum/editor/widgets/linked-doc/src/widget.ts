import { signal } from "@preact/signals-core";
import { IS_MOBILE } from "@virgultum/global/env";
import type { RootBlockModel } from "@virgultum/model";
import { hasPendingAnnotationInput } from "@virgultum/shared/adapters";
import {
  EditorChromeHostIdentifier,
  FeatureFlagService,
} from "@virgultum/shared/services";
import { getViewportElement } from "@virgultum/shared/utils";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  WidgetComponent,
  WidgetViewExtension,
} from "@virgultum/std";
import {
  INLINE_ROOT_ATTR,
  type InlineEditor,
  type InlineRootElement,
} from "@virgultum/std/inline";
import { html, nothing } from "lit";
import { literal, unsafeStatic } from "lit/static-html.js";

import {
  getMenus,
  type LinkedDocContext,
  type LinkedWidgetConfig,
  LinkedWidgetConfigExtension,
  MYOXUS_LINKED_DOC_WIDGET,
} from "./config.js";
import { highlightDocumentQuery } from "./document-picker-highlight";
import { DocumentPickerSession } from "./document-picker-session";

export class MyoxusLinkedDocWidget extends WidgetComponent<RootBlockModel> {
  private _context: LinkedDocContext | null = null;
  private session?: DocumentPickerSession;

  private readonly _mode$ = signal<"desktop" | "mobile" | "none">("none");

  private _addTriggerKey(inlineEditor: InlineEditor, triggerKey: string) {
    const inlineRange = inlineEditor.getInlineRange();
    if (!inlineRange) return;
    inlineEditor.insertText(
      { index: inlineRange.index, length: 0 },
      triggerKey,
    );
    inlineEditor.setInlineRange({
      index: inlineRange.index + triggerKey.length,
      length: 0,
    });
  }

  private _watchInput() {
    this.handleEvent("beforeInput", (ctx) => {
      if (this._mode$.peek() !== "none") return;

      const event = ctx.get("defaultState").event;
      if (!(event instanceof InputEvent)) return;

      if (event.data === null) return;

      const host = this.std.host;

      const range = host.range.value;
      if (!range || !range.collapsed) return;

      const containerElement =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      if (!containerElement) return;

      if (containerElement.closest(this.config.ignoreSelector)) return;

      const block = containerElement.closest<BlockComponent>(
        `[${BLOCK_ID_ATTR}]`,
      );
      if (!block || this.config.ignoreBlockTypes.includes(block.flavour))
        return;

      const inlineRoot = containerElement.closest<InlineRootElement>(
        `[${INLINE_ROOT_ATTR}]`,
      );
      if (!inlineRoot) return;

      const inlineEditor = inlineRoot.inlineEditor;
      const inlineRange = inlineEditor.getInlineRange();
      if (!inlineRange) return;

      // An open annotation is literal input, not a document-link authoring path.
      if (
        hasPendingAnnotationInput(
          block.model.text?.sliceToDelta(0, inlineRange.index) ?? [],
        )
      )
        return;

      const triggerKeys = this.config.triggerKeys;
      const primaryTriggerKey = triggerKeys[0];
      const matchedTriggerKey = triggerKeys.find(
        (key) =>
          key.length <= inlineRange.index &&
          inlineEditor.yTextString.slice(
            inlineRange.index - key.length,
            inlineRange.index,
          ) === key,
      );
      if (!matchedTriggerKey) return;

      // Recognition is independent of conversion: ranges must use the text
      // actually left in the editor, including two-character wiki triggers.
      const triggerKey = this.config.convertTriggerKey
        ? primaryTriggerKey
        : matchedTriggerKey;
      if (triggerKey !== matchedTriggerKey) {
        const index = inlineRange.index - matchedTriggerKey.length;
        inlineEditor.deleteText({ index, length: matchedTriggerKey.length });
        inlineEditor.insertText({ index, length: 0 }, triggerKey);
        inlineEditor.setInlineRange({
          index: index + triggerKey.length,
          length: 0,
        });
      }

      inlineEditor
        .waitForUpdate()
        .then(() => {
          this.show({
            inlineEditor,
            primaryTriggerKey: triggerKey,
            mode: IS_MOBILE ? "mobile" : "desktop",
          });
        })
        .catch(console.error);
    });
  }

  get config(): LinkedWidgetConfig {
    return {
      triggerKeys: ["@", "[[", "【【"],
      ignoreBlockTypes: ["myoxus:code"],
      ignoreSelector:
        "edgeless-text-editor, edgeless-shape-text-editor, edgeless-group-title-editor, edgeless-frame-title-editor, edgeless-connector-label-editor",
      convertTriggerKey: true,
      getMenus,
      mobile: {
        scrollContainer: getViewportElement(this.std.host) ?? window,
        scrollTopOffset: 46,
      },
      ...this.std.getOptional(LinkedWidgetConfigExtension.identifier),
    };
  }

  override connectedCallback() {
    super.connectedCallback();

    this._watchInput();
  }

  show(props?: {
    inlineEditor?: InlineEditor;
    primaryTriggerKey?: string;
    mode?: "desktop" | "mobile";
    addTriggerKey?: boolean;
  }) {
    this.session?.cancel();
    const host = this.host;
    const {
      primaryTriggerKey = "@",
      mode = "desktop",
      addTriggerKey = false,
    } = props ?? {};
    let inlineEditor: InlineEditor;
    if (!props?.inlineEditor) {
      const range = host.range.value;
      if (!range || !range.collapsed) return;
      const containerElement =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      if (!containerElement) return;
      const inlineRoot = containerElement.closest<InlineRootElement>(
        `[${INLINE_ROOT_ATTR}]`,
      );
      if (!inlineRoot) return;
      inlineEditor = inlineRoot.inlineEditor;
    } else {
      inlineEditor = props.inlineEditor;
    }

    if (addTriggerKey) {
      this._addTriggerKey(inlineEditor, primaryTriggerKey);
      // Wait for the inserted trigger's inline range before starting the session.
      const subscription = inlineEditor.slots.inlineRangeSync.subscribe(() => {
        this.show({ ...props, addTriggerKey: false });
        subscription.unsubscribe();
      });
      return;
    }

    const startRange = inlineEditor.getInlineRange();
    if (!startRange) return;

    let stopHighlight = () => {};
    this._context = {
      std: this.std,
      inlineEditor,
      startRange,
      triggerKey: primaryTriggerKey,
      config: this.config,
      close: () => {
        this.session?.cancel();
        this.session = undefined;
        stopHighlight();
        this._mode$.value = "none";
        this._context = null;
      },
    };

    stopHighlight = highlightDocumentQuery(this._context);

    const enableMobile = this.store
      .get(FeatureFlagService)
      .getFlag("enable_mobile_linked_doc_menu");
    this._mode$.value = enableMobile ? mode : "desktop";
    if (this._mode$.value === "desktop") {
      if (!inlineEditor.eventSource) {
        this._context.close();
        return;
      }
      this.session = new DocumentPickerSession(this._context);
    }
  }

  override disconnectedCallback() {
    this.session?.cancel();
    this._context?.close();
    super.disconnectedCallback();
  }

  override render() {
    if (this._mode$.value === "none") return nothing;
    const template =
      this._mode$.value === "desktop"
        ? this.session
          ? (this.std
              .getOptional(EditorChromeHostIdentifier)
              ?.renderDocumentPicker(this.session) ?? nothing)
          : nothing
        : this.block?.rootComponent
          ? html`<myoxus-mobile-linked-doc-menu
              .context=${this._context}
            ></myoxus-mobile-linked-doc-menu>`
          : nothing;
    return html`<virgultum-portal
      .shadowDom=${false}
      .template=${template}
    ></virgultum-portal>`;
  }
}

export const linkedDocWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_LINKED_DOC_WIDGET,
  literal`${unsafeStatic(MYOXUS_LINKED_DOC_WIDGET)}`,
);

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_LINKED_DOC_WIDGET]: MyoxusLinkedDocWidget;
  }
}
