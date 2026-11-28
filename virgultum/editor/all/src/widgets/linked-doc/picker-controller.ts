// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { signal } from "@preact/signals-core";
import { hasPendingAnnotationInput } from "@virgultum/core/adapters";
import type { RootBlockModel } from "@virgultum/core/models";
import { IS_MOBILE } from "@virgultum/core/primitives/env";
import {
  BLOCK_ID_ATTR,
  NativeEditorWidget,
  WidgetViewExtension,
  type BlockComponent,
} from "@virgultum/core/runtime";
import {
  INLINE_ROOT_ATTR,
  type InlineEditor,
  type InlineRootElement,
} from "@virgultum/core/runtime/inline";
import {
  EditorChromeHostIdentifier,
  FeatureFlagService,
} from "@virgultum/core/services";
import { getViewportElement } from "@virgultum/core/utils";

import { highlightDocumentQuery } from "./document-picker-highlight";
import { DocumentPickerSession } from "./document-picker-session";
import {
  LinkedWidgetConfigExtension,
  MYOXUS_LINKED_DOC_WIDGET,
  getMenus,
  type LinkedDocContext,
  type LinkedWidgetConfig,
} from "./picker-config.js";

export type LinkedDocShowOptions = {
  inlineEditor?: InlineEditor;
  primaryTriggerKey?: string;
  mode?: "desktop" | "mobile";
  addTriggerKey?: boolean;
};

type TriggerInputHost = {
  isActive: () => boolean;
  config: Pick<
    LinkedWidgetConfig,
    "triggerKeys" | "convertTriggerKey" | "ignoreSelector" | "ignoreBlockTypes"
  >;
  getRange: () => Range | null;
  show: (options: LinkedDocShowOptions) => void;
};

const DEFAULT_IGNORE_SELECTOR =
  "edgeless-text-editor, edgeless-shape-text-editor, edgeless-group-title-editor, edgeless-frame-title-editor, edgeless-connector-label-editor";

/**
 * Evaluates a `beforeInput` event against configured trigger tokens (`@`, `[[`,
 * `【【`), skipping ignored blocks/selectors and pending annotation syntax.
 */
export function handleLinkedDocBeforeInput(
  host: TriggerInputHost,
  event: Event,
): void {
  if (host.isActive()) return;
  if (!(event instanceof InputEvent) || event.data === null) return;

  const range = host.getRange();
  if (!range || !range.collapsed) return;

  const container =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!container) return;

  if (
    host.config.ignoreSelector &&
    container.closest(host.config.ignoreSelector)
  ) {
    return;
  }

  const block = container.closest<BlockComponent>(`[${BLOCK_ID_ATTR}]`);
  if (!block || host.config.ignoreBlockTypes.includes(block.flavour)) return;

  const inlineRoot = container.closest<InlineRootElement>(
    `[${INLINE_ROOT_ATTR}]`,
  );
  if (!inlineRoot) return;

  const inlineEditor = inlineRoot.inlineEditor;
  const inlineRange = inlineEditor.getInlineRange();
  if (!inlineRange) return;

  // Pending annotation syntax (`%%...`) stays literal text rather than opening a link picker.
  if (
    hasPendingAnnotationInput(
      block.model.text?.sliceToDelta(0, inlineRange.index) ?? [],
    )
  ) {
    return;
  }

  const { triggerKeys, convertTriggerKey } = host.config;
  const matched = triggerKeys.find(
    (token) =>
      token.length <= inlineRange.index &&
      inlineEditor.yTextString.slice(
        inlineRange.index - token.length,
        inlineRange.index,
      ) === token,
  );
  if (!matched) return;

  const effectiveTrigger = convertTriggerKey ? triggerKeys[0] : matched;
  if (effectiveTrigger !== matched) {
    const start = inlineRange.index - matched.length;
    inlineEditor.deleteText({ index: start, length: matched.length });
    inlineEditor.insertText({ index: start, length: 0 }, effectiveTrigger);
    inlineEditor.setInlineRange({
      index: start + effectiveTrigger.length,
      length: 0,
    });
  }

  inlineEditor
    .waitForUpdate()
    .then(() => {
      host.show({
        inlineEditor,
        primaryTriggerKey: effectiveTrigger,
        mode: IS_MOBILE ? "mobile" : "desktop",
      });
    })
    .catch(console.error);
}

/**
 * Widget host for `@`/`[[` document linking in Edgeless Notes, Edgeless Text,
 * and the Comment Editor. Mounts {@link DocumentPickerSession} via
 * {@link EditorChromeHostIdentifier.mountDocumentPicker}, including `"docked"`
 * presentation when mobile linked-doc mode is requested.
 */
export class MyoxusLinkedDocWidget extends NativeEditorWidget<RootBlockModel> {
  private _activeContext: LinkedDocContext | null = null;
  private _session: DocumentPickerSession | null = null;
  private _unmountChrome: (() => void) | null = null;
  private readonly _active$ = signal(false);

  get config(): LinkedWidgetConfig {
    return {
      triggerKeys: ["@", "[[", "【【"],
      ignoreBlockTypes: ["myoxus:code"],
      ignoreSelector: DEFAULT_IGNORE_SELECTOR,
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
    this.handleEvent("beforeInput", (ctx) => {
      const event = ctx.get("defaultState").event;
      handleLinkedDocBeforeInput(
        {
          isActive: () => this._active$.peek(),
          config: this.config,
          getRange: () => this.std.host.range.value ?? null,
          show: (options) => this.show(options),
        },
        event,
      );
    });
  }

  override disconnectedCallback() {
    this._activeContext?.close();
    super.disconnectedCallback();
  }

  private _resolveInlineEditor(explicit?: InlineEditor): InlineEditor | null {
    if (explicit) return explicit;
    const range = this.host.range.value;
    if (!range || !range.collapsed) return null;
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    return (
      container?.closest<InlineRootElement>(`[${INLINE_ROOT_ATTR}]`)
        ?.inlineEditor ?? null
    );
  }

  private _insertTriggerToken(inlineEditor: InlineEditor, token: string): void {
    const range = inlineEditor.getInlineRange();
    if (!range) return;
    inlineEditor.insertText({ index: range.index, length: 0 }, token);
    inlineEditor.setInlineRange({
      index: range.index + token.length,
      length: 0,
    });
  }

  show(options?: LinkedDocShowOptions): void {
    this._activeContext?.close();

    const primaryTriggerKey = options?.primaryTriggerKey ?? "@";
    const requestedMode = options?.mode ?? "desktop";
    const addTriggerKey = options?.addTriggerKey ?? false;

    const inlineEditor = this._resolveInlineEditor(options?.inlineEditor);
    if (!inlineEditor) return;

    if (addTriggerKey) {
      this._insertTriggerToken(inlineEditor, primaryTriggerKey);
      const subscription = inlineEditor.slots.inlineRangeSync.subscribe(() => {
        subscription.unsubscribe();
        this.show({ ...options, inlineEditor, addTriggerKey: false });
      });
      return;
    }

    const startRange = inlineEditor.getInlineRange();
    if (!startRange || !inlineEditor.eventSource) return;

    let releaseHighlight = () => {};
    const context: LinkedDocContext = {
      std: this.std,
      inlineEditor,
      startRange,
      triggerKey: primaryTriggerKey,
      config: this.config,
      close: () => {
        if (this._activeContext !== context) return;
        this._activeContext = null;
        const session = this._session;
        this._session = null;
        session?.cancel();
        const unmount = this._unmountChrome;
        this._unmountChrome = null;
        unmount?.();
        releaseHighlight();
        this._active$.value = false;
      },
    };

    this._activeContext = context;
    this._active$.value = true;
    releaseHighlight = highlightDocumentQuery(context);

    const mobileEnabled = this.std.store
      .get(FeatureFlagService)
      .getFlag("enable_mobile_linked_doc_menu");
    const presentation =
      mobileEnabled && requestedMode === "mobile" ? "docked" : undefined;

    const session = new DocumentPickerSession(context, presentation);
    if (this._activeContext !== context) return;
    this._session = session;

    const anchor = this.ownerDocument.createElement("div");
    this.ownerDocument.body.append(anchor);
    const releaseChrome = this.std
      .get(EditorChromeHostIdentifier)
      .mountDocumentPicker(anchor, session);
    this._unmountChrome = () => {
      releaseChrome();
      anchor.remove();
    };
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
