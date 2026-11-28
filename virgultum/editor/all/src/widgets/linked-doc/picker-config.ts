// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Signal } from "@preact/signals-core";
import { insertLinkedNode } from "@virgultum/content/inlines";
import { StoreExtensionManagerIdentifier } from "@virgultum/core/extensions";
import { IS_MOBILE } from "@virgultum/core/primitives/env";
import {
  ConfigExtensionFactory,
  type BlockStdScope,
  type EditorHost,
} from "@virgultum/core/runtime";
import type { InlineRange } from "@virgultum/core/runtime/inline";
import {
  DocEmbedProvider,
  DocModeProvider,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  TelemetryProvider,
  editorMessage,
  resolveEditorMessage,
  type EditorDocumentPickerItem,
} from "@virgultum/core/services";
import type { MyoxusInlineEditor } from "@virgultum/core/types";
import {
  createDefaultDoc,
  editorToast,
  isFuzzyMatch,
} from "@virgultum/core/utils";

export const MYOXUS_LINKED_DOC_WIDGET = "myoxus-linked-doc-widget";

export type LinkedMenuAction = () => Promise<void> | void;

export type LinkedMenuItem = Omit<EditorDocumentPickerItem, "id"> & {
  key: string;
  action: LinkedMenuAction;
};

export type LinkedMenuGroup = {
  name: string;
  emptyMessage?: string;
  items: LinkedMenuItem[] | Signal<LinkedMenuItem[]>;
  maxDisplay?: number;
  loading?: boolean | Signal<boolean>;
  overflowText?: string | Signal<string>;
  hidden?: boolean | Signal<boolean>;
};

export type LinkedDocMobileOptions = {
  scrollContainer?: string | HTMLElement | Window;
  scrollTopOffset?: number | (() => number);
};

export type LinkedDocViewExtensionOptions = {
  triggerKeys?: [string, ...string[]];
  convertTriggerKey?: boolean;
  ignoreBlockTypes?: string[];
  ignoreSelector?: string;
  getMenus?: (
    query: string,
    abort: () => void,
    editorHost: EditorHost,
    inlineEditor: MyoxusInlineEditor,
    abortSignal: AbortSignal,
    triggerKey?: string,
  ) => Promise<LinkedMenuGroup[]> | LinkedMenuGroup[];
  autoFocusedItemKey?: (
    groups: LinkedMenuGroup[],
    query: string,
    activeKey: string | null,
    editorHost: EditorHost,
    inlineEditor: MyoxusInlineEditor,
  ) => string | null;
  mobile?: LinkedDocMobileOptions;
};

export type LinkedWidgetConfig = Required<
  Omit<LinkedDocViewExtensionOptions, "autoFocusedItemKey">
> &
  Pick<LinkedDocViewExtensionOptions, "autoFocusedItemKey">;

export type LinkedDocContext = {
  std: BlockStdScope;
  inlineEditor: MyoxusInlineEditor;
  startRange: InlineRange;
  triggerKey: string;
  config: LinkedWidgetConfig;
  close: () => void;
};

export const LinkedWidgetConfigExtension = ConfigExtensionFactory<
  Partial<LinkedWidgetConfig>
>("myoxus:widget-linked-doc");

/** Reads either a plain value or a Preact Signal's current value. */
export function resolveSignal<T>(value: T | Signal<T>): T {
  return value instanceof Signal ? value.value : value;
}

const UNTITLED_LABEL = "Untitled";
const MAX_DISPLAY_NAME_CHARS = 8;
const MAX_DEFAULT_DOCS = 6;

export function createLinkedDocMenuGroup(
  query: string,
  abort: () => void,
  editorHost: EditorHost,
  inlineEditor: MyoxusInlineEditor,
): LinkedMenuGroup {
  const store = editorHost.store;
  const matches = store.workspace.meta.docMetas.filter(
    (meta) => meta.id !== store.id && isFuzzyMatch(meta.title, query),
  );
  const docMode = editorHost.std.get(DocModeProvider);

  return {
    name: "Link to Doc",
    items: matches.map((meta) => ({
      key: meta.id,
      name: meta.title || UNTITLED_LABEL,
      icon:
        docMode.getPrimaryMode(meta.id) === "edgeless"
          ? "EdgelessIcon"
          : "LinkIcon",
      action: () => {
        abort();
        insertLinkedNode({ inlineEditor, docId: meta.id });
        editorHost.std
          .getOptional(TelemetryProvider)
          ?.track("LinkedDocCreated", {
            control: "linked doc",
            module: "inline @",
            type: "doc",
            other: "existing doc",
          });
      },
    })),
    maxDisplay: MAX_DEFAULT_DOCS,
    overflowText: `${matches.length - MAX_DEFAULT_DOCS} more docs`,
  };
}

export function createNewDocMenuGroup(
  query: string,
  abort: () => void,
  editorHost: EditorHost,
  inlineEditor: MyoxusInlineEditor,
): LinkedMenuGroup {
  const store = editorHost.store;
  const rawName = query || UNTITLED_LABEL;
  const shortened =
    rawName.length > MAX_DISPLAY_NAME_CHARS
      ? `${rawName.slice(0, MAX_DISPLAY_NAME_CHARS)}..`
      : rawName;

  const items: LinkedMenuItem[] = [
    {
      key: "create",
      name: `Create "${shortened}" doc`,
      icon: "NewXxxPageIcon",
      action: () => {
        abort();
        const created = createDefaultDoc(store.workspace, { title: query });
        insertLinkedNode({ inlineEditor, docId: created.id });
        const telemetry = editorHost.std.getOptional(TelemetryProvider);
        telemetry?.track("LinkedDocCreated", {
          control: "new doc",
          module: "inline @",
          type: "doc",
          other: "new doc",
        });
        telemetry?.track("DocCreated", {
          control: "new doc",
          module: "inline @",
          type: "doc",
        });
      },
    },
  ];

  if (!IS_MOBILE) {
    items.push({
      key: "import",
      name: "Import",
      icon: "ImportIcon",
      action: async () => {
        abort();
        const i18n =
          editorHost.std.getOptional(EditorI18nProvider) ?? undefined;
        const onSuccess = (
          docIds: string[],
          options: { importedCount: number },
        ) => {
          editorToast(
            editorHost,
            resolveEditorMessage(
              editorMessage(
                "com.myoxus.editor.import.success",
                "Successfully imported {{count}} documents.",
                { count: options.importedCount },
              ),
              i18n,
            ),
          );
          for (const docId of docIds) {
            insertLinkedNode({ inlineEditor, docId });
          }
        };
        const onFail = (message: string) => {
          editorToast(editorHost, message);
        };
        const storeManager = editorHost.std.get(
          StoreExtensionManagerIdentifier,
        );
        const { showImportModal } = await import("../../interchange/index.js");
        if (!editorHost.isConnected) return;
        showImportModal({
          chrome: editorHost.std.get(EditorChromeHostIdentifier),
          i18n,
          collection: store.workspace,
          schema: store.schema,
          extensions: storeManager.get("store"),
          onSuccess,
          onFail,
          access: editorHost.std.getOptional(DocEmbedProvider) ?? undefined,
        });
      },
    });
  }

  return {
    name: "New Doc",
    items,
  };
}

export function getMenus(
  query: string,
  abort: () => void,
  editorHost: EditorHost,
  inlineEditor: MyoxusInlineEditor,
): Promise<LinkedMenuGroup[]> {
  return Promise.resolve([
    createLinkedDocMenuGroup(query, abort, editorHost, inlineEditor),
    createNewDocMenuGroup(query, abort, editorHost, inlineEditor),
  ]);
}

export const LinkedWidgetUtils = {
  createNewDocMenuGroup,
  insertLinkedNode,
};
