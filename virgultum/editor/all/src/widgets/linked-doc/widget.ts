import { signal } from "@preact/signals-core";
import { IS_MOBILE } from "@virgultum/core/primitives/env";
import type { RootBlockModel } from "@virgultum/core/models";
import { hasPendingAnnotationInput } from "@virgultum/core/adapters";
import {
  EditorChromeHostIdentifier,
  FeatureFlagService,
} from "@virgultum/core/services";
import { getViewportElement } from "@virgultum/core/utils";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  NativeEditorWidget,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
import {
  INLINE_ROOT_ATTR,
  type InlineEditor,
  type InlineRootElement,
} from "@virgultum/core/runtime/inline";

import {
  getMenus,
  type LinkedDocContext,
  type LinkedWidgetConfig,
  LinkedWidgetConfigExtension,
  MYOXUS_LINKED_DOC_WIDGET,
} from "./config.js";
import { highlightDocumentQuery } from "./document-picker-highlight";
import type { MyoxusMobileLinkedDocMenu } from "./mobile-linked-doc-menu";
import { DocumentPickerSession } from "./document-picker-session";

export class MyoxusLinkedDocWidget extends NativeEditorWidget<RootBlockModel> {
  private _context: LinkedDocContext | null = null;
  private session?: DocumentPickerSession;
  private unmount?: () => void;

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
    this._context?.close();
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
    const context: LinkedDocContext = {
      std: this.std,
      inlineEditor,
      startRange,
      triggerKey: primaryTriggerKey,
      config: this.config,
      close: () => {
        if (this._context !== context) return;
        const session = this.session;
        this.session = undefined;
        this._context = null;
        session?.cancel();
        const unmount = this.unmount;
        this.unmount = undefined;
        unmount?.();
        stopHighlight();
        this._mode$.value = "none";
      },
    };

    this._context = context;
    stopHighlight = highlightDocumentQuery(context);

    const enableMobile = this.std.store
      .get(FeatureFlagService)
      .getFlag("enable_mobile_linked_doc_menu");
    this._mode$.value = enableMobile ? mode : "desktop";
    if (this._mode$.value === "desktop") {
      if (!inlineEditor.eventSource) {
        this._context.close();
        return;
      }
      const session = new DocumentPickerSession(context);
      if (this._context !== context) return;
      this.session = session;
      // The picker uses viewport coordinates, including when Canvas is transformed.
      const anchor = this.ownerDocument.createElement("div");
      this.ownerDocument.body.append(anchor);
      const release = this.std
        .get(EditorChromeHostIdentifier)
        .mountDocumentPicker(anchor, session);
      this.unmount = () => {
        release();
        anchor.remove();
      };
    } else if (this.block?.rootComponent) {
      const menu = this.ownerDocument.createElement(
        "myoxus-mobile-linked-doc-menu",
      ) as MyoxusMobileLinkedDocMenu;
      menu.context = this._context;
      this.unmount = () => menu.remove();
      this.ownerDocument.body.append(menu);
    }
  }

  override disconnectedCallback() {
    this._context?.close();
    super.disconnectedCallback();
  }
}

export const linkedDocWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_LINKED_DOC_WIDGET,
  MYOXUS_LINKED_DOC_WIDGET,
);

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_LINKED_DOC_WIDGET]: MyoxusLinkedDocWidget;
  }
}
